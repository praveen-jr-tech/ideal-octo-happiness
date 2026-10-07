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
const {
  effectiveMembership,
  loadCardLevelSettings,
  transferQuote,
} = require("./card_levels");
const { issueVerificationCode, normalizeCollegeEmail } = require("./email_verification");

function publicAccount(row, balancePaise) {
  return {
    id: row.id,
    role: row.role,
    collegeId: row.college_id,
    name: row.name,
    photoData: row.photo_data || null,
    email: row.email || row.pending_email || null,
    emailVerified: Boolean(row.email_verified_at),
    frozen: row.frozen,
    balancePaise,
    testMode: true,
  };
}

function assertRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new HttpError(400, "requestId must be 8-100 letters, digits, underscores, or hyphens");
  }
  return value;
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
      const email = normalizeCollegeEmail(req.body?.email, config.allowedEmailDomains);
      const trimmedName = String(name || "").trim();
      if (trimmedName.length < 2 || trimmedName.length > 80) {
        throw new HttpError(400, "name must be 2-80 characters");
      }
      const id = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO accounts (id, role, college_id, name, pin_hash, email, frozen)
           VALUES ($1, 'student', $2, $3, $4, $5, FALSE)`,
          [id, collegeId.toUpperCase(), trimmedName, hashPin(pin), email]
        );
      } catch (err) {
        if (err.code === "23505") {
          throw new HttpError(409, "collegeId already registered");
        }
        throw err;
      }
      const { rows } = await pool.query("SELECT * FROM accounts WHERE id = $1", [id]);
      await issueVerificationCode(pool, { accountId: id, email, config });
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
      const settings = await loadCardLevelSettings(pool);
      res.json({
        ...publicAccount(rows[0], balancePaise),
        cardMembership: effectiveMembership(
          rows[0],
          new Date(),
          Number(settings.emberfall_grace_days)
        ),
      });
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
      const requestId = assertRequestId(req.body?.requestId);
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
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
        const { rows: priorRequests } = await client.query(
          `SELECT sender_id, recipient_id, amount_paise, fee_paise
           FROM student_transfer_requests WHERE request_id = $1 FOR UPDATE`,
          [requestId]
        );
        if (priorRequests[0]) {
          const prior = priorRequests[0];
          if (prior.sender_id !== req.auth.sub || Number(prior.amount_paise) !== amountPaise) {
            throw new HttpError(409, "requestId was already used for a different transfer");
          }
          const { rows: existingRecipient } = await client.query(
            "SELECT college_id, name FROM accounts WHERE id = $1 AND role = 'student'",
            [prior.recipient_id]
          );
          if (!existingRecipient[0]) throw new HttpError(404, "Transfer recipient not found");
          const balancePaise = await getBalancePaise(client, req.auth.sub);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            amountPaise,
            feePaise: Number(prior.fee_paise),
            recipient: {
              collegeId: existingRecipient[0].college_id,
              name: existingRecipient[0].name,
            },
            balancePaise,
          });
        }
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

        const settings = await loadCardLevelSettings(client);
        const membership = effectiveMembership(sender, new Date(), Number(settings.emberfall_grace_days));
        const quote = transferQuote({
          cardLevel: membership.level,
          amountPaise,
          settings,
          purpose: "friend_transfer",
        });

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
        if (balancePaise < quote.totalDebitPaise) throw new HttpError(400, "Insufficient test balance including the transfer fee");
        const debitEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: debitEntryId,
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
        if (quote.feePaise > 0) {
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: sender.id,
            amountPaise: -quote.feePaise,
            entryType: "transfer_fee",
            note: `NFC transfer fee (${membership.level})`,
          });
        }
        await client.query(
          `INSERT INTO student_transfer_requests
             (request_id, sender_id, recipient_id, amount_paise, fee_paise, debit_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [requestId, sender.id, recipient.id, amountPaise, quote.feePaise, debitEntryId]
        );
        await client.query("DELETE FROM nfc_sessions WHERE token_hash = $1", [tokenHash]);
        await client.query("COMMIT");
        res.json({
          ok: true,
          amountPaise,
          feePaise: quote.feePaise,
          totalDebitPaise: quote.totalDebitPaise,
          cardLevel: membership.level,
          recipient: { collegeId: recipient.college_id, name: recipient.name },
          balancePaise: balancePaise - quote.totalDebitPaise,
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
      const requestId = assertRequestId(req.body?.requestId);
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
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
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
        const recipient = rows.find((row) => row.college_id === recipientCollegeId);
        if (!recipient) throw new HttpError(404, "Student not found");
        const { rows: priorRequests } = await client.query(
          `SELECT sender_id, recipient_id, amount_paise, fee_paise
           FROM student_transfer_requests WHERE request_id = $1 FOR UPDATE`,
          [requestId]
        );
        if (priorRequests[0]) {
          const prior = priorRequests[0];
          if (
            prior.sender_id !== sender.id ||
            prior.recipient_id !== recipient.id ||
            Number(prior.amount_paise) !== amountPaise
          ) {
            throw new HttpError(409, "requestId was already used for a different transfer");
          }
          const balancePaise = await getBalancePaise(client, sender.id);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            amountPaise,
            feePaise: Number(prior.fee_paise),
            recipient: { collegeId: recipient.college_id, name: recipient.name },
            balancePaise,
          });
        }
        if (sender.frozen) throw new HttpError(403, "Your wallet is frozen");
        if (recipient.id === sender.id) throw new HttpError(400, "You cannot send money to yourself");
        if (recipient.frozen) throw new HttpError(403, "That student's wallet is frozen");

        const settings = await loadCardLevelSettings(client);
        const membership = effectiveMembership(sender, new Date(), Number(settings.emberfall_grace_days));
        const quote = transferQuote({
          cardLevel: membership.level,
          amountPaise,
          settings,
          purpose: "friend_transfer",
        });
        const balancePaise = await getBalancePaise(client, sender.id);
        if (balancePaise < quote.totalDebitPaise) throw new HttpError(400, "Insufficient test balance including the transfer fee");

        const transferNote = note || `To ${recipient.name}`;
        const debitEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: debitEntryId,
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
        if (quote.feePaise > 0) {
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: sender.id,
            amountPaise: -quote.feePaise,
            entryType: "transfer_fee",
            note: `Friend transfer fee (${membership.level})`,
          });
        }
        await client.query(
          `INSERT INTO student_transfer_requests
             (request_id, sender_id, recipient_id, amount_paise, fee_paise, debit_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [requestId, sender.id, recipient.id, amountPaise, quote.feePaise, debitEntryId]
        );

        const updatedBalancePaise = balancePaise - quote.totalDebitPaise;
        await client.query("COMMIT");
        res.json({
          ok: true,
          amountPaise,
          feePaise: quote.feePaise,
          totalDebitPaise: quote.totalDebitPaise,
          cardLevel: membership.level,
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
        `SELECT id, amount_paise, cost_paise, entry_type, note, created_at
         FROM ledger_entries WHERE account_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [req.auth.sub]
      );
      res.json({ entries: rows });
    })
  );
}

module.exports = { mountStudentRoutes, publicAccount };
