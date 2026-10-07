const crypto = require("crypto");
const { HttpError } = require("./db");
const {
  asyncHandler,
  authRequired,
  assertPinFormat,
  verifyPin,
} = require("./auth");
const { getBalancePaise, insertEntry } = require("./ledger");
const { expireLapsedTopupEntries, grantYearlyFreeEntry } = require("./event_entries");

const CARD_LEVELS = {
  STARROW: {
    name: "STARROW",
    paid: false,
    benefits: [
      "Free wallet top-ups and QR/ID-card payments",
      "Receive money from other students",
      "No offers, cashback, early-bird prices, free entries, or priority passes",
      "Friend transfers are unavailable except approved hackathon paybacks",
    ],
  },
  FENWICK: {
    name: "FENWICK",
    paid: true,
    benefits: [
      "All STARROW wallet features",
      "Offers, cashback, milestone and referral rewards",
      "Early-bird event prices, scratch cards, and priority fest passes",
      "Friend transfers with the configured fee",
    ],
  },
  EMBERFALL: {
    name: "EMBERFALL",
    paid: true,
    benefits: [
      "Every FENWICK benefit",
      "No transfer or withdrawal fee",
      "One free college event entry per membership year",
      "Renewal is manual; unused top-up entries do not carry over",
    ],
  },
};

function effectiveMembership(account, now = new Date(), graceDays = 15) {
  const recordedLevel = CARD_LEVELS[account.card_level] ? account.card_level : "STARROW";
  const expiresAt = account.card_level_expires_at ? new Date(account.card_level_expires_at) : null;
  let level = recordedLevel;
  let inGracePeriod = false;

  if (recordedLevel !== "STARROW" && expiresAt && expiresAt <= now) {
    if (recordedLevel === "EMBERFALL" && now <= new Date(expiresAt.getTime() + graceDays * 86400000)) {
      inGracePeriod = true;
    } else {
      level = recordedLevel === "EMBERFALL" ? (account.card_level_fallback || "STARROW") : "STARROW";
    }
  }

  const daysUntilExpiry = expiresAt && recordedLevel !== "STARROW"
    ? Math.ceil((expiresAt.getTime() - now.getTime()) / 86400000)
    : null;

  return {
    level,
    recordedLevel,
    billingPeriod: account.card_level_period || null,
    startedAt: account.card_level_started_at || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    fallbackLevel: account.card_level_fallback || "STARROW",
    inGracePeriod,
    benefitsPaused: Boolean(account.frozen),
    reminderDue: Boolean(
      recordedLevel !== "STARROW" &&
      expiresAt &&
      daysUntilExpiry !== null &&
      daysUntilExpiry >= 0 &&
      daysUntilExpiry <= 30
    ),
    daysUntilExpiry,
  };
}

function calculatePercentageFee(amountPaise, basisPoints, settings) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new HttpError(400, "amountPaise must be a positive integer");
  }
  if (!basisPoints) return 0;
  const percentageFee = Math.ceil((amountPaise * basisPoints) / 10000);
  return Math.min(
    Number(settings.maximum_fee_paise),
    Math.max(Number(settings.minimum_fee_paise), percentageFee)
  );
}

function transferQuote({ cardLevel, amountPaise, settings, purpose }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new HttpError(400, "amountPaise must be a positive integer");
  }
  if (cardLevel === "STARROW" && purpose !== "hackathon_payback") {
    throw new HttpError(403, "STARROW can send money only for an approved hackathon team payback");
  }
  const feePaise = cardLevel === "FENWICK"
    ? calculatePercentageFee(amountPaise, Number(settings.fenwick_transfer_fee_bps), settings)
    : 0;
  return {
    cardLevel,
    amountPaise,
    feePaise,
    totalDebitPaise: amountPaise + feePaise,
    recipientReceivesPaise: amountPaise,
    feeRateBps: cardLevel === "FENWICK" ? Number(settings.fenwick_transfer_fee_bps) : 0,
    purpose,
  };
}

function withdrawalQuote({ cardLevel, amountPaise, settings }) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new HttpError(400, "amountPaise must be a positive integer");
  }
  const rate = cardLevel === "STARROW"
    ? Number(settings.starrow_withdrawal_fee_bps)
    : cardLevel === "FENWICK"
      ? Number(settings.fenwick_withdrawal_fee_bps)
      : 0;
  const feePaise = calculatePercentageFee(amountPaise, rate, settings);
  return {
    cardLevel,
    amountPaise,
    feePaise,
    totalDebitPaise: amountPaise + feePaise,
    feeRateBps: rate,
  };
}

function publicCardCatalog(settings) {
  return {
    levels: [
      { ...CARD_LEVELS.STARROW, prices: { free: true }, transferFeeBps: null, withdrawalFeeBps: Number(settings.starrow_withdrawal_fee_bps) },
      {
        ...CARD_LEVELS.FENWICK,
        prices: {
          semesterPaise: Number(settings.fenwick_semester_price_paise),
          yearPaise: Number(settings.fenwick_year_price_paise),
        },
        transferFeeBps: Number(settings.fenwick_transfer_fee_bps),
        withdrawalFeeBps: Number(settings.fenwick_withdrawal_fee_bps),
      },
      {
        ...CARD_LEVELS.EMBERFALL,
        prices: {
          firstYearPaise: Number(settings.emberfall_first_year_price_paise),
          renewalYearPaise: Number(settings.emberfall_renewal_price_paise),
        },
        transferFeeBps: 0,
        withdrawalFeeBps: 0,
        graceDays: Number(settings.emberfall_grace_days),
        topUpEntryPricePaise: 29900,
      },
    ],
    feeBounds: {
      minimumFeePaise: Number(settings.minimum_fee_paise),
      maximumFeePaise: Number(settings.maximum_fee_paise),
    },
    testMode: true,
  };
}

async function loadCardLevelSettings(client) {
  const { rows } = await client.query("SELECT * FROM card_level_settings WHERE id = 1");
  if (!rows[0]) throw new Error("Card level settings are missing");
  return rows[0];
}

function validateSettings(body) {
  const fields = [
    "fenwick_semester_price_paise",
    "fenwick_year_price_paise",
    "emberfall_first_year_price_paise",
    "emberfall_renewal_price_paise",
    "fenwick_transfer_fee_bps",
    "starrow_withdrawal_fee_bps",
    "fenwick_withdrawal_fee_bps",
    "minimum_fee_paise",
    "maximum_fee_paise",
    "emberfall_grace_days",
  ];
  const values = {};
  for (const field of fields) {
    const value = body[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new HttpError(400, `${field} must be a non-negative integer`);
    }
    values[field] = value;
  }
  for (const field of [
    "fenwick_transfer_fee_bps",
    "starrow_withdrawal_fee_bps",
    "fenwick_withdrawal_fee_bps",
  ]) {
    if (values[field] > 10000) throw new HttpError(400, `${field} cannot exceed 10000 basis points`);
  }
  if (values.minimum_fee_paise > values.maximum_fee_paise) {
    throw new HttpError(400, "minimum_fee_paise cannot exceed maximum_fee_paise");
  }
  if (values.emberfall_grace_days < 7 || values.emberfall_grace_days > 15) {
    throw new HttpError(400, "emberfall_grace_days must be between 7 and 15");
  }
  return values;
}

function addUtcYears(date, years) {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

function validateRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new HttpError(400, "requestId must be 8-100 letters, digits, underscores, or hyphens");
  }
  return value;
}

function mountStudentCardLevelRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");

  app.get(
    "/students/card-levels",
    studentAuth,
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        "SELECT * FROM accounts WHERE id = $1 AND role = 'student'",
        [req.auth.sub]
      );
      if (!rows[0]) throw new HttpError(404, "Student not found");
      const settings = await loadCardLevelSettings(pool);
      const membership = effectiveMembership(
        rows[0],
        new Date(),
        Number(settings.emberfall_grace_days)
      );
      res.json({
        catalog: publicCardCatalog(settings),
        emberfallPurchasePricePaise: rows[0].emberfall_first_started_at
          ? Number(settings.emberfall_renewal_price_paise)
          : Number(settings.emberfall_first_year_price_paise),
        membership: {
          ...membership,
          benefits: CARD_LEVELS[membership.level].benefits,
          renewalReminder: membership.reminderDue
            ? "Your membership expires soon. Renewal is manual."
            : null,
        },
      });
    })
  );

  app.post(
    "/students/card-levels/purchase",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "Card-level purchases are available only in local test mode");
      }
      const level = String(req.body?.level || "").toUpperCase();
      const period = String(req.body?.period || "").toLowerCase();
      const requestId = validateRequestId(req.body?.requestId);
      if (level !== "FENWICK" && level !== "EMBERFALL") {
        throw new HttpError(400, "Choose FENWICK or EMBERFALL");
      }
      if (
        (level === "FENWICK" && !["semester", "year"].includes(period)) ||
        (level === "EMBERFALL" && period !== "year")
      ) {
        throw new HttpError(400, "Choose a valid billing period for this card level");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
        const { rows } = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        const student = rows[0];
        if (!student) throw new HttpError(404, "Student not found");
        if (student.frozen) throw new HttpError(403, "Unfreeze your wallet before changing card levels");

        const { rows: priorRequests } = await client.query(
          "SELECT account_id, card_level, billing_period, amount_paise, expires_at FROM membership_purchases WHERE request_id = $1",
          [requestId]
        );
        if (priorRequests[0]) {
          if (priorRequests[0].account_id !== student.id) {
            throw new HttpError(409, "requestId was already used for another account");
          }
          const balancePaise = await getBalancePaise(client, student.id);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            level: priorRequests[0].card_level,
            period: priorRequests[0].billing_period,
            chargedPaise: Number(priorRequests[0].amount_paise),
            expiresAt: priorRequests[0].expires_at,
            balancePaise,
          });
        }

        const settings = await loadCardLevelSettings(client);
        const now = new Date();
        const membership = effectiveMembership(student, now, Number(settings.emberfall_grace_days));
        await expireLapsedTopupEntries(client, student, membership);
        const recordedExpiry = student.card_level_expires_at
          ? new Date(student.card_level_expires_at)
          : null;
        const currentInRenewalWindow = Boolean(
          student.card_level === level &&
          recordedExpiry &&
          (
            recordedExpiry >= now ||
            (
              level === "EMBERFALL" &&
              now <= new Date(recordedExpiry.getTime() + Number(settings.emberfall_grace_days) * 86400000)
            )
          )
        );
        if (membership.level === "EMBERFALL" && level === "FENWICK") {
          throw new HttpError(409, "Your active EMBERFALL membership already includes FENWICK benefits");
        }

        const pricePaise = level === "FENWICK"
          ? Number(period === "semester" ? settings.fenwick_semester_price_paise : settings.fenwick_year_price_paise)
          : student.emberfall_first_started_at
            ? Number(settings.emberfall_renewal_price_paise)
            : Number(settings.emberfall_first_year_price_paise);
        if (!Number.isSafeInteger(pricePaise) || pricePaise < 0) {
          throw new Error("Configured membership price is invalid");
        }
        const balancePaise = await getBalancePaise(client, student.id);
        if (balancePaise < pricePaise) throw new HttpError(400, "Insufficient wallet balance for this membership");

        const startsAt = currentInRenewalWindow ? recordedExpiry : now;
        const expiresAt = new Date(startsAt);
        if (level === "FENWICK" && period === "semester") {
          expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 6);
        } else {
          expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + 1);
        }
        let firstEmberfallStartedAt = student.emberfall_first_started_at;
        if (level === "EMBERFALL") {
          firstEmberfallStartedAt = firstEmberfallStartedAt || now;
          const courseEndsAt = addUtcYears(firstEmberfallStartedAt, 4);
          if (startsAt >= courseEndsAt) {
            throw new HttpError(400, "Your four-year EMBERFALL membership term has ended");
          }
          if (expiresAt > courseEndsAt) expiresAt.setTime(courseEndsAt.getTime());
        }

        const currentFallback = student.card_level === "FENWICK" &&
            (membership.level === "FENWICK" || student.card_level === "EMBERFALL")
          ? "FENWICK"
          : student.card_level_fallback || "STARROW";
        const fallbackLevel = level === "EMBERFALL" && membership.level === "FENWICK"
          ? "FENWICK"
          : level === "EMBERFALL" && student.card_level === "EMBERFALL"
            ? currentFallback
            : "STARROW";
        const ledgerEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: ledgerEntryId,
          accountId: student.id,
          amountPaise: -pricePaise,
          entryType: "card_membership_fee",
          note: `${level} ${period} membership`,
        });
        await client.query(
          `UPDATE accounts SET card_level = $1, card_level_period = $2,
             card_level_started_at = CASE WHEN $3 THEN card_level_started_at ELSE $4 END,
             card_level_expires_at = $5, card_level_fallback = $6,
             emberfall_first_started_at = $7
           WHERE id = $8`,
          [
            level,
            period,
            currentInRenewalWindow && student.card_level === level,
            startsAt.toISOString(),
            expiresAt.toISOString(),
            fallbackLevel,
            firstEmberfallStartedAt,
            student.id,
          ]
        );
        await client.query(
          `INSERT INTO membership_purchases
             (request_id, account_id, card_level, billing_period, amount_paise, starts_at, expires_at, ledger_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            requestId,
            student.id,
            level,
            period,
            pricePaise,
            startsAt.toISOString(),
            expiresAt.toISOString(),
            ledgerEntryId,
          ]
        );
        if (level === "EMBERFALL") {
          await grantYearlyFreeEntry(client, {
            accountId: student.id,
            membershipRequestId: requestId,
          });
        }
        const updatedBalancePaise = balancePaise - pricePaise;
        await client.query("COMMIT");
        res.json({
          ok: true,
          duplicate: false,
          level,
          period,
          chargedPaise: pricePaise,
          startsAt: startsAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          graceDays: level === "EMBERFALL" ? Number(settings.emberfall_grace_days) : 0,
          balancePaise: updatedBalancePaise,
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
    "/students/transfer/quote",
    studentAuth,
    asyncHandler(async (req, res) => {
      const amountPaise = Number(req.body?.amountPaise);
      const purpose = String(req.body?.purpose || "friend_transfer");
      const { rows } = await pool.query(
        "SELECT * FROM accounts WHERE id = $1 AND role = 'student'",
        [req.auth.sub]
      );
      if (!rows[0]) throw new HttpError(404, "Student not found");
      if (rows[0].frozen) throw new HttpError(403, "Your wallet is frozen");
      const settings = await loadCardLevelSettings(pool);
      const membership = effectiveMembership(rows[0], new Date(), Number(settings.emberfall_grace_days));
      const quote = transferQuote({
        cardLevel: membership.level,
        amountPaise,
        settings,
        purpose,
      });
      res.json({ ...quote, testMode: true });
    })
  );

  app.post(
    "/students/withdrawal/quote",
    studentAuth,
    asyncHandler(async (req, res) => {
      const amountPaise = Number(req.body?.amountPaise);
      const { rows } = await pool.query(
        "SELECT * FROM accounts WHERE id = $1 AND role = 'student'",
        [req.auth.sub]
      );
      if (!rows[0]) throw new HttpError(404, "Student not found");
      if (rows[0].frozen) throw new HttpError(403, "Your wallet is frozen");
      const settings = await loadCardLevelSettings(pool);
      const membership = effectiveMembership(rows[0], new Date(), Number(settings.emberfall_grace_days));
      res.json({
        ...withdrawalQuote({ cardLevel: membership.level, amountPaise, settings }),
        simulated: true,
        testMode: true,
      });
    })
  );

  app.post(
    "/students/withdrawal",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) {
        throw new HttpError(403, "Withdrawals are available only as test simulations");
      }
      const amountPaise = Number(req.body?.amountPaise);
      const requestId = validateRequestId(req.body?.requestId);
      const holderName = String(req.body?.accountHolderName || "").trim().replace(/\s+/g, " ");
      const destinationType = String(req.body?.destinationType || "").toLowerCase();
      const destination = String(req.body?.destination || "").trim();
      const pin = req.body?.pin;
      assertPinFormat(pin);
      if (!["bank", "upi"].includes(destinationType)) {
        throw new HttpError(400, "Choose a bank account or UPI ID");
      }
      const validDestination = destinationType === "bank"
        ? /^\d{9,18}$/.test(destination)
        : /^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(destination);
      if (!validDestination) {
        throw new HttpError(400, destinationType === "bank"
          ? "Enter a valid test bank account number"
          : "Enter a valid UPI ID");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
        const { rows } = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        const student = rows[0];
        if (!student) throw new HttpError(404, "Student not found");
        if (!verifyPin(pin, student.pin_hash)) throw new HttpError(401, "Wrong PIN");
        if (student.frozen) throw new HttpError(403, "Your wallet is frozen");
        if (holderName.toLowerCase() !== String(student.name).trim().replace(/\s+/g, " ").toLowerCase()) {
          throw new HttpError(400, "The destination holder name must match your student account name");
        }
        const { rows: priorRequests } = await client.query(
          "SELECT account_id, amount_paise, fee_paise FROM withdrawal_requests WHERE request_id = $1",
          [requestId]
        );
        if (priorRequests[0]) {
          if (priorRequests[0].account_id !== student.id) {
            throw new HttpError(409, "requestId was already used for another account");
          }
          const balancePaise = await getBalancePaise(client, student.id);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            amountPaise: Number(priorRequests[0].amount_paise),
            feePaise: Number(priorRequests[0].fee_paise),
            balancePaise,
            simulated: true,
            testMode: true,
          });
        }

        const settings = await loadCardLevelSettings(client);
        const membership = effectiveMembership(student, new Date(), Number(settings.emberfall_grace_days));
        const quote = withdrawalQuote({ cardLevel: membership.level, amountPaise, settings });
        const balancePaise = await getBalancePaise(client, student.id);
        if (balancePaise < quote.totalDebitPaise) {
          throw new HttpError(400, "Insufficient test balance including the withdrawal fee");
        }
        const ledgerEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: ledgerEntryId,
          accountId: student.id,
          amountPaise: -amountPaise,
          entryType: "test_withdrawal",
          note: `Simulated withdrawal to ${destinationType} (destination not stored)`,
        });
        if (quote.feePaise > 0) {
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: student.id,
            amountPaise: -quote.feePaise,
            entryType: "withdrawal_fee",
            note: `Withdrawal fee (${membership.level})`,
          });
        }
        await client.query(
          `INSERT INTO withdrawal_requests
             (request_id, account_id, amount_paise, fee_paise, destination_type, ledger_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [requestId, student.id, amountPaise, quote.feePaise, destinationType, ledgerEntryId]
        );
        const updatedBalancePaise = balancePaise - quote.totalDebitPaise;
        await client.query("COMMIT");
        res.json({
          ok: true,
          duplicate: false,
          amountPaise,
          feePaise: quote.feePaise,
          totalDebitPaise: quote.totalDebitPaise,
          balancePaise: updatedBalancePaise,
          simulated: true,
          testMode: true,
          message: "Recorded as a test ledger entry only; no money was sent to a bank or UPI account.",
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );
}

function mountAdminCardLevelRoutes(app, { pool }) {
  app.get(
    "/admin/card-level-settings",
    asyncHandler(async (_req, res) => {
      const settings = await loadCardLevelSettings(pool);
      res.json({ settings: publicCardCatalog(settings), editable: settings });
    })
  );

  app.put(
    "/admin/card-level-settings",
    asyncHandler(async (req, res) => {
      const values = validateSettings(req.body || {});
      const { rows } = await pool.query(
        `UPDATE card_level_settings SET
           fenwick_semester_price_paise = $1,
           fenwick_year_price_paise = $2,
           emberfall_first_year_price_paise = $3,
           emberfall_renewal_price_paise = $4,
           fenwick_transfer_fee_bps = $5,
           starrow_withdrawal_fee_bps = $6,
           fenwick_withdrawal_fee_bps = $7,
           minimum_fee_paise = $8,
           maximum_fee_paise = $9,
           emberfall_grace_days = $10,
           updated_at = NOW()
         WHERE id = 1 RETURNING *`,
        [
          values.fenwick_semester_price_paise,
          values.fenwick_year_price_paise,
          values.emberfall_first_year_price_paise,
          values.emberfall_renewal_price_paise,
          values.fenwick_transfer_fee_bps,
          values.starrow_withdrawal_fee_bps,
          values.fenwick_withdrawal_fee_bps,
          values.minimum_fee_paise,
          values.maximum_fee_paise,
          values.emberfall_grace_days,
        ]
      );
      res.json({ ok: true, editable: rows[0], catalog: publicCardCatalog(rows[0]) });
    })
  );

  app.get(
    "/admin/team-invite-settings",
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query(
        `SELECT team_invites_per_leader_hour, team_invites_per_leader_day,
                team_invites_per_recipient_leader_hour,
                team_invite_recipient_cooldown_seconds,
                team_invites_per_recipient_day, team_invites_per_ip_hour
         FROM card_level_settings WHERE id = 1`
      );
      if (!rows[0]) throw new Error("Team invitation settings are missing");
      res.json({ editable: rows[0] });
    })
  );

  app.put(
    "/admin/team-invite-settings",
    asyncHandler(async (req, res) => {
      const fields = [
        ["team_invites_per_leader_hour", 1, 1000],
        ["team_invites_per_leader_day", 1, 5000],
        ["team_invites_per_recipient_leader_hour", 1, 1000],
        ["team_invite_recipient_cooldown_seconds", 1, 3600],
        ["team_invites_per_recipient_day", 1, 5000],
        ["team_invites_per_ip_hour", 1, 10000],
      ];
      const values = fields.map(([field, minimum, maximum]) => {
        const value = req.body?.[field];
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
          throw new HttpError(400, `${field} must be between ${minimum} and ${maximum}`);
        }
        return value;
      });
      const { rows } = await pool.query(
        `UPDATE card_level_settings SET
           team_invites_per_leader_hour = $1,
           team_invites_per_leader_day = $2,
           team_invites_per_recipient_leader_hour = $3,
           team_invite_recipient_cooldown_seconds = $4,
           team_invites_per_recipient_day = $5,
           team_invites_per_ip_hour = $6,
           updated_at = NOW()
         WHERE id = 1
         RETURNING team_invites_per_leader_hour, team_invites_per_leader_day,
                   team_invites_per_recipient_leader_hour,
                   team_invite_recipient_cooldown_seconds,
                   team_invites_per_recipient_day, team_invites_per_ip_hour`,
        values
      );
      if (!rows[0]) throw new Error("Team invitation settings are missing");
      res.json({ ok: true, editable: rows[0] });
    })
  );
}

module.exports = {
  CARD_LEVELS,
  effectiveMembership,
  calculatePercentageFee,
  transferQuote,
  withdrawalQuote,
  publicCardCatalog,
  loadCardLevelSettings,
  mountStudentCardLevelRoutes,
  mountAdminCardLevelRoutes,
};
