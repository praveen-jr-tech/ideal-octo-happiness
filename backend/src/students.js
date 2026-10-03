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
    photoData: row.photo_data || null,
    frozen: row.frozen,
    balancePaise,
    testMode: true,
  };
}

function mountStudentRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");

  app.post(
    "/login",
    asyncHandler(async (req, res) => {
      const { collegeId, pin } = req.body || {};
      assertCollegeId(collegeId);
      if (collegeId.toUpperCase() === "ADMIN") {
        if (String(pin || "") !== config.adminKey) throw new HttpError(401, "Invalid ID or password");
        const admin = { id: "admin", role: "admin", college_id: "ADMIN" };
        return res.json({ token: signToken(config, admin), role: "admin" });
      }
      assertPinFormat(pin);
      const { rows } = await pool.query("SELECT * FROM accounts WHERE college_id = $1", [collegeId.toUpperCase()]);
      if (!rows[0] || !verifyPin(pin, rows[0].pin_hash)) {
        throw new HttpError(401, "Invalid ID or password");
      }
      const balancePaise = await getBalancePaise(pool, rows[0].id);
      res.json({ token: signToken(config, rows[0]), role: rows[0].role, account: publicAccount(rows[0], balancePaise) });
    })
  );

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

  app.get(
    "/students/directory",
    studentAuth,
    asyncHandler(async (req, res) => {
      const query = String(req.query.q || "").trim().slice(0, 80).toLowerCase();
      const { rows } = await pool.query(
        `SELECT college_id, name, photo_data
         FROM accounts
         WHERE role = 'student' AND frozen = FALSE AND id <> $1
           AND ($2 = '' OR POSITION($2 IN LOWER(name)) > 0
                OR POSITION($2 IN LOWER(college_id)) > 0)
         ORDER BY name, college_id
         LIMIT 30`,
        [req.auth.sub, query]
      );
      res.json({
        students: rows.map((row) => ({
          collegeId: row.college_id,
          name: row.name,
          photoData: row.photo_data || null,
        })),
      });
    })
  );

  app.post(
    "/students/nfc/session",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "NFC transfers are available only in local test mode");
      }
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT id, frozen FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        if (!rows[0]) throw new HttpError(404, "Student not found");
        if (rows[0].frozen) throw new HttpError(403, "Your wallet is frozen");
        await client.query(
          "DELETE FROM nfc_sessions WHERE expires_at <= NOW() OR student_id = $1",
          [rows[0].id]
        );
        const session = await client.query(
          `INSERT INTO nfc_sessions (token_hash, student_id, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '2 minutes')
           RETURNING expires_at`,
          [tokenHash, rows[0].id]
        );
        await client.query("COMMIT");
        res.json({ token, expiresAt: session.rows[0].expires_at });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.post(
    "/students/nfc/transfer",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "NFC transfers are available only in local test mode");
      }
      const { recipientToken, amountPaise } = req.body || {};
      if (typeof recipientToken !== "string" || recipientToken.length < 20 || recipientToken.length > 100) {
        throw new HttpError(400, "recipientToken is invalid");
      }
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new HttpError(400, "amountPaise must be a positive integer");
      }
      if (amountPaise > 50000) throw new HttpError(400, "NFC transfers are limited to ₹500 per tap");
      const note = String((req.body && req.body.note) || "").trim();
      if (note.length > 100) throw new HttpError(400, "note must be 100 characters or fewer");

      const tokenHash = crypto.createHash("sha256").update(recipientToken).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: sessions } = await client.query(
          `SELECT student_id FROM nfc_sessions
           WHERE token_hash = $1 AND expires_at > NOW()
           FOR UPDATE`,
          [tokenHash]
        );
        if (!sessions[0]) {
          throw new HttpError(410, "NFC receive session expired; ask the recipient to tap again");
        }
        const recipientId = sessions[0].student_id;
        const { rows } = await client.query(
          `SELECT * FROM accounts
           WHERE id = ANY($1::uuid[]) AND role = 'student'
           ORDER BY id
           FOR UPDATE`,
          [[req.auth.sub, recipientId]]
        );
        const sender = rows.find((row) => row.id === req.auth.sub);
        const recipient = rows.find((row) => row.id === recipientId);
        if (!sender || !recipient) throw new HttpError(404, "Student not found");
        if (sender.frozen) throw new HttpError(403, "Your wallet is frozen");
        if (recipient.frozen) throw new HttpError(403, "That student's wallet is frozen");
        if (sender.id === recipient.id) throw new HttpError(400, "You cannot send money to yourself");

        const { rows: totals } = await client.query(
          `SELECT COALESCE(SUM(-amount_paise), 0)::bigint AS spent
           FROM ledger_entries
           WHERE account_id = $1 AND entry_type = 'nfc_transfer_out'
             AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
          [sender.id]
        );
        if (Number(totals[0].spent) + amountPaise > 200000) {
          throw new HttpError(400, "NFC transfers are limited to ₹2,000 per day");
        }

        const balancePaise = await getBalancePaise(client, sender.id);
        if (balancePaise < amountPaise) throw new HttpError(400, "Insufficient test balance");
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: sender.id,
          amountPaise: -amountPaise,
          entryType: "nfc_transfer_out",
          relatedAccountId: recipient.id,
          note: `To ${recipient.name} · NFC`,
        });
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: recipient.id,
          amountPaise,
          entryType: "nfc_transfer_in",
          relatedAccountId: sender.id,
          note: `From ${sender.name} · NFC`,
        });
        await client.query("DELETE FROM nfc_sessions WHERE token_hash = $1", [tokenHash]);
        await client.query("COMMIT");
        res.json({
          ok: true,
          amountPaise,
          recipient: { collegeId: recipient.college_id, name: recipient.name },
          balancePaise: balancePaise - amountPaise,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.post(
    "/students/transfer",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "Student transfers are available only in local test mode");
      }
      const { collegeId, pin, amountPaise } = req.body || {};
      const recipientCollegeId = assertCollegeId(collegeId);
      assertPinFormat(pin);
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new HttpError(400, "amountPaise must be a positive integer");
      }
      const note = String((req.body && req.body.note) || "").trim();
      if (note.length > 100) throw new HttpError(400, "note must be 100 characters or fewer");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `SELECT * FROM accounts
           WHERE (id = $1 AND role = 'student')
              OR (college_id = $2 AND role = 'student')
           ORDER BY id
           FOR UPDATE`,
          [req.auth.sub, recipientCollegeId]
        );
        const sender = rows.find((row) => row.id === req.auth.sub);
        if (!sender || !verifyPin(pin, sender.pin_hash)) throw new HttpError(401, "Wrong PIN");
        if (sender.frozen) throw new HttpError(403, "Your wallet is frozen");

        const recipient = rows.find((row) => row.college_id === recipientCollegeId);
        if (!recipient) throw new HttpError(404, "Student not found");
        if (recipient.id === sender.id) throw new HttpError(400, "You cannot send money to yourself");
        if (recipient.frozen) throw new HttpError(403, "That student's wallet is frozen");

        const balancePaise = await getBalancePaise(client, sender.id);
        if (balancePaise < amountPaise) throw new HttpError(400, "Insufficient test balance");

        const transferNote = note || `To ${recipient.name}`;
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: sender.id,
          amountPaise: -amountPaise,
          entryType: "student_transfer_out",
          relatedAccountId: recipient.id,
          note: `To ${recipient.name}${note ? ` · ${note}` : ""}`,
        });
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: recipient.id,
          amountPaise,
          entryType: "student_transfer_in",
          relatedAccountId: sender.id,
          note: `From ${sender.name}${note ? ` · ${note}` : ""}`,
        });

        const updatedBalancePaise = balancePaise - amountPaise;
        await client.query("COMMIT");
        res.json({
          ok: true,
          amountPaise,
          recipient: {
            collegeId: recipient.college_id,
            name: recipient.name,
          },
          balancePaise: updatedBalancePaise,
          note: transferNote,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
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
        throw new HttpError(400, "amountPaise must be 1-100000");
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
        note: "Wallet top-up",
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
