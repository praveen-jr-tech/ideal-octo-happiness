const crypto = require("crypto");
const {
  asyncHandler,
  authRequired,
} = require("./auth");
const { HttpError } = require("./db");

function normalizeCollegeEmail(value, allowedDomains) {
  if (typeof value !== "string") {
    throw new HttpError(400, "A college email address is required");
  }
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+$/.test(email) ||
    !allowedDomains.includes(email.slice(email.lastIndexOf("@") + 1))
  ) {
    throw new HttpError(400, "Use an email address from an allowed college domain");
  }
  return email;
}

function codeHash(code, secret) {
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

async function sendTestEmail(config, message) {
  if (!config.testMode) {
    if (typeof config.emailSender !== "function") {
      throw new HttpError(503, "Email delivery is not configured");
    }
    await config.emailSender(message);
    return;
  }
  const logger = config.emailLogger || ((value) => console.log(value));
  logger(message);
}

async function issueVerificationCode(pool, { accountId, email, config }) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const { rows } = await client.query(
      "SELECT id, email, pending_email, email_verified_at FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
      [accountId]
    );
    const account = rows[0];
    if (!account) throw new HttpError(404, "Student not found");
    const { rows: conflicts } = await client.query(
      "SELECT id FROM accounts WHERE id <> $1 AND (email = $2 OR pending_email = $2) LIMIT 1",
      [accountId, email]
    );
    if (conflicts[0]) {
      throw new HttpError(400, "If eligible, a verification email was sent");
    }
    await client.query(
      `UPDATE accounts
       SET pending_email = CASE WHEN email = $2 THEN NULL ELSE $2 END
       WHERE id = $1`,
      [accountId, email]
    );
    await client.query(
      `UPDATE email_verification_codes SET used_at = NOW()
       WHERE account_id = $1 AND used_at IS NULL`,
      [accountId]
    );
    await client.query(
      `INSERT INTO email_verification_codes
         (id, account_id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')`,
      [crypto.randomUUID(), accountId, email, codeHash(code, config.jwtSecret)]
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw new HttpError(400, "If eligible, a verification email was sent");
    }
    throw error;
  } finally {
    client.release();
  }
  await sendTestEmail(config, {
    to: email,
    subject: "Campus Wallet college email verification",
    text: `Your Campus Wallet verification code is ${code}. It expires in 10 minutes.`,
  });
}

function mountEmailVerificationRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");

  app.post(
    "/students/email-verification/request",
    studentAuth,
    asyncHandler(async (req, res) => {
      const email = normalizeCollegeEmail(req.body?.email, config.allowedEmailDomains);
      await issueVerificationCode(pool, {
        accountId: req.auth.sub,
        email,
        config,
      });
      res.json({ ok: true, message: "If eligible, a verification email was sent." });
    })
  );

  app.post(
    "/students/email-verification/confirm",
    studentAuth,
    asyncHandler(async (req, res) => {
      const suppliedCode = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(suppliedCode)) {
        throw new HttpError(400, "Invalid or expired verification code");
      }
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const { rows } = await client.query(
          `SELECT evc.*, evc.email AS verification_email,
                  a.email AS account_email, a.pending_email
           FROM email_verification_codes evc
           JOIN accounts a ON a.id = evc.account_id
           WHERE evc.account_id = $1 AND evc.used_at IS NULL
           ORDER BY evc.created_at DESC LIMIT 1
           FOR UPDATE OF evc, a`,
          [req.auth.sub]
        );
        const verification = rows[0];
        if (
          !verification ||
          new Date(verification.expires_at) <= new Date() ||
          Number(verification.attempts) >= 5 ||
          (verification.pending_email || verification.account_email) !== verification.verification_email
        ) {
          throw new HttpError(400, "Invalid or expired verification code");
        }
        const expected = Buffer.from(verification.code_hash, "hex");
        const supplied = Buffer.from(codeHash(suppliedCode, config.jwtSecret), "hex");
        if (!crypto.timingSafeEqual(expected, supplied)) {
          await client.query(
            "UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = $1",
            [verification.id]
          );
          await client.query("COMMIT");
          transactionOpen = false;
          throw new HttpError(400, "Invalid or expired verification code");
        }
        await client.query(
          `UPDATE accounts
           SET email = $2, email_verified_at = NOW(), pending_email = NULL
           WHERE id = $1`,
          [req.auth.sub, verification.verification_email]
        );
        await client.query(
          "UPDATE email_verification_codes SET used_at = NOW() WHERE id = $1",
          [verification.id]
        );
        await client.query("COMMIT");
        transactionOpen = false;
        res.json({ ok: true, emailVerified: true });
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );
}

module.exports = {
  issueVerificationCode,
  mountEmailVerificationRoutes,
  normalizeCollegeEmail,
  sendTestEmail,
};
