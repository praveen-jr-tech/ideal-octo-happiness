const crypto = require("crypto");
const {
  assertCollegeId,
  assertPinFormat,
  verifyPin,
  signToken,
  authRequired,
  asyncHandler,
} = require("./auth");
const { HttpError } = require("./db");
const { getBalancePaise, payMerchant } = require("./ledger");
const { publicAccount } = require("./students");

function mountMerchantRoutes(app, { pool, config }) {
  const merchantAuth = authRequired(config, "merchant");

  app.post(
    "/merchants/login",
    asyncHandler(async (req, res) => {
      const { collegeId, pin } = req.body || {};
      assertCollegeId(collegeId);
      assertPinFormat(pin);
      const { rows } = await pool.query(
        "SELECT * FROM accounts WHERE college_id = $1 AND role = 'merchant'",
        [collegeId.toUpperCase()]
      );
      if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
        throw new HttpError(401, "Unknown merchant or wrong PIN");
      }
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json({ token: signToken(config, rows[0]), account: publicAccount(rows[0], balancePaise) });
    })
  );

  app.get(
    "/merchants/me",
    merchantAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1 AND role = 'merchant'", [
        req.auth.sub,
      ]);
      if (!rows[0]) throw new HttpError(404, "Merchant not found");
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json(publicAccount(rows[0], balancePaise));
    })
  );

  app.post(
    "/merchants/charge",
    merchantAuth,
    asyncHandler(async (req, res) => {
      const token = String((req.body && req.body.token) || "").trim();
      const amountPaise = Number(req.body && req.body.amountPaise);
      const paymentId = String((req.body && req.body.paymentId) || "").trim();
      if (!token) throw new HttpError(400, "token is required");
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(paymentId)) {
        throw new HttpError(400, "paymentId must be 8-100 letters, digits, underscores, or hyphens");
      }
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new HttpError(400, "amountPaise must be a positive integer");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`qr-payment:${paymentId}`]
        );
        const priorPayment = await client.query(
          `SELECT payment_id, merchant_id, student_id, amount_paise, student_balance_paise
           FROM qr_payment_requests WHERE payment_id = $1`,
          [paymentId]
        );
        if (priorPayment.rows[0]) {
          const prior = priorPayment.rows[0];
          if (
            prior.merchant_id !== req.auth.sub ||
            Number(prior.amount_paise) !== amountPaise
          ) {
            throw new HttpError(409, "paymentId was already used for a different payment");
          }
          const student = await client.query(
            "SELECT college_id FROM accounts WHERE id = $1 AND role = 'student'",
            [prior.student_id]
          );
          if (!student.rows[0]) throw new HttpError(404, "Student not found");
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            paymentId: prior.payment_id,
            chargedPaise: Number(prior.amount_paise),
            fromCollegeId: student.rows[0].college_id,
            studentBalancePaise: Number(prior.student_balance_paise),
            testMode: true,
          });
        }
        const merchantRes = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'merchant' FOR UPDATE",
          [req.auth.sub]
        );
        if (!merchantRes.rows[0]) throw new HttpError(404, "Merchant not found");
        const qrRes = await client.query(
          `SELECT q.*, a.id AS sid, a.college_id, a.name, a.frozen, a.role
           FROM qr_tokens q
           JOIN accounts a ON a.id = q.student_id
           WHERE q.token = $1
           FOR UPDATE OF q`,
          [token]
        );
        if (!qrRes.rows[0]) throw new HttpError(400, "Unknown QR token");
        if (qrRes.rows[0].used_at) throw new HttpError(409, "This QR code has already been used; ask the student to refresh it");
        if (new Date(qrRes.rows[0].expires_at) < new Date()) {
          throw new HttpError(400, "QR expired — ask the student to refresh");
        }
        const student = {
          id: qrRes.rows[0].sid,
          college_id: qrRes.rows[0].college_id,
          name: qrRes.rows[0].name,
          frozen: qrRes.rows[0].frozen,
          role: qrRes.rows[0].role,
        };
        const studentLock = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [student.id]
        );
        if (!studentLock.rows[0]) throw new HttpError(400, "Student account missing");
        const result = await payMerchant(client, {
          student: studentLock.rows[0],
          merchant: merchantRes.rows[0],
          amountPaise,
          crypto,
        });
        const consumedQr = await client.query(
          "UPDATE qr_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL",
          [qrRes.rows[0].id]
        );
        if (consumedQr.rowCount !== 1) {
          throw new HttpError(409, "This QR code has already been used; ask the student to refresh it");
        }
        await client.query(
          `INSERT INTO qr_payment_requests
             (payment_id, merchant_id, student_id, qr_token_id, amount_paise,
              student_balance_paise, debit_entry_id, credit_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            paymentId,
            merchantRes.rows[0].id,
            studentLock.rows[0].id,
            qrRes.rows[0].id,
            amountPaise,
            result.studentBalancePaise,
            result.debitId,
            result.creditId,
          ]
        );
        await client.query("COMMIT");
        res.json({
          ok: true,
          paymentId,
          duplicate: false,
          chargedPaise: amountPaise,
          fromCollegeId: studentLock.rows[0].college_id,
          studentBalancePaise: result.studentBalancePaise,
          testMode: true,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    "/merchants/ledger",
    merchantAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT id, amount_paise, cost_paise, entry_type, note, created_at
         FROM ledger_entries WHERE account_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [req.auth.sub]
      );
      res.json({ entries: rows });
    })
  );
}

module.exports = { mountMerchantRoutes };
