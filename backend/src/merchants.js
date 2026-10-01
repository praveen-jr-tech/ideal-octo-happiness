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
      if (!token) throw new HttpError(400, "token is required");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
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
        await client.query("COMMIT");
        res.json({
          ok: true,
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
        `SELECT id, amount_paise, entry_type, note, created_at
         FROM ledger_entries WHERE account_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [req.auth.sub]
      );
      res.json({ entries: rows });
    })
  );
}

module.exports = { mountMerchantRoutes };
