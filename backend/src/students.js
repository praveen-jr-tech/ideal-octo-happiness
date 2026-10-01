const crypto = require("crypto");
const {
  assertCollegeId,
  assertPinFormat,
  hashPin,
  verifyPin,
  signToken,
  authRequired,
  asyncHandler,
} = require("./auth");
const { HttpError } = require("./db");
const { getBalancePaise, insertEntry } = require("./ledger");

function publicAccount(row, balancePaise) {
  return {
    id: row.id,
    role: row.role,
    collegeId: row.college_id,
    name: row.name,
    frozen: row.frozen,
    balancePaise,
    testMode: true,
  };
}

function mountStudentRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");

  app.post(
    "/students/signup",
    asyncHandler(async (req, res) => {
      const { collegeId, name, pin } = req.body || {};
      assertCollegeId(collegeId);
      assertPinFormat(pin);
      const trimmedName = String(name || "").trim();
      if (trimmedName.length < 2 || trimmedName.length > 80) {
        throw new HttpError(400, "name must be 2-80 characters");
      }
      const id = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen)
           VALUES ($1, 'student', $2, $3, $4, FALSE)`,
          [id, collegeId.toUpperCase(), trimmedName, hashPin(pin)]
        );
      } catch (err) {
        if (err.code === "23505") {
          throw new HttpError(409, "collegeId already registered");
        }
        throw err;
      }
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1", [id]);
      const token = signToken(config, rows[0]);
      res.status(201).json({ token, account: publicAccount(rows[0], 0) });
    })
  );

  app.post(
    "/students/login",
    asyncHandler(async (req, res) => {
      const { collegeId, pin } = req.body || {};
      assertCollegeId(collegeId);
      assertPinFormat(pin);
      const { rows } = await pool.query(
        "SELECT * FROM accounts WHERE college_id = $1 AND role = 'student'",
        [collegeId.toUpperCase()]
      );
      if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
        throw new HttpError(401, "Unknown student or wrong PIN");
      }
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json({ token: signToken(config, rows[0]), account: publicAccount(rows[0], balancePaise) });
    })
  );

  app.get(
    "/students/me",
    studentAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1 AND role = 'student'", [
        req.auth.sub,
      ]);
      if (!rows[0]) throw new HttpError(404, "Student not found");
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json(publicAccount(rows[0], balancePaise));
    })
  );

  app.post(
    "/students/test-topup",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "Test top-up disabled; real payments are not connected");
      }
      const amountPaise = Number((req.body && req.body.amountPaise) || 10000);
      if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > 100000) {
        throw new HttpError(400, "amountPaise must be 1-100000 in test mode");
      }
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1 AND role = 'student'", [
        req.auth.sub,
      ]);
      if (!rows[0]) throw new HttpError(404, "Student not found");
      if (rows[0].frozen) throw new HttpError(403, "Account is frozen");
      await insertEntry(pool, {
        id: crypto.randomUUID(),
        accountId: rows[0].id,
        amountPaise,
        entryType: "test_topup",
        note: "Local TEST_MODE credit — not real money",
      });
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json({ ok: true, creditedPaise: amountPaise, account: publicAccount(rows[0], balancePaise) });
    })
  );

  app.get(
    "/students/qr",
    studentAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1 AND role = 'student'", [
        req.auth.sub,
      ]);
      if (!rows[0]) throw new HttpError(404, "Student not found");
      if (rows[0].frozen) throw new HttpError(403, "Account is frozen");
      const token = `CW1.${crypto.randomBytes(18).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + config.qrTtlSeconds * 1000);
      await pool.query(
        `INSERT INTO qr_tokens (id, student_id, token, expires_at) VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), rows[0].id, token, expiresAt.toISOString()]
      );
      res.json({ token, expiresAt: expiresAt.toISOString(), ttlSeconds: config.qrTtlSeconds });
    })
  );

  app.post(
    "/students/freeze",
    studentAuth,
    asyncHandler(async (req, res) => {
      const frozen = Boolean(req.body && req.body.frozen);
      const pin = req.body && req.body.pin;
      assertPinFormat(pin);
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1 AND role = 'student'", [
        req.auth.sub,
      ]);
      if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
        throw new HttpError(401, "Wrong PIN");
      }
      await pool.query("UPDATE accounts SET frozen = $1 WHERE id = $2", [frozen, rows[0].id]);
      const updated = (await pool.query("SELECT * FROM accounts WHERE id = $1", [rows[0].id])).rows[0];
      const balancePaise = await getBalancePaise(pool, updated.id);
      res.json(publicAccount(updated, balancePaise));
    })
  );

  app.get(
    "/students/ledger",
    studentAuth,
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

module.exports = { mountStudentRoutes, publicAccount };
