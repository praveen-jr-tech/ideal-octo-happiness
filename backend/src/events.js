const crypto = require("crypto");
const { HttpError } = require("./db");
const { asyncHandler, authRequired, assertCollegeId } = require("./auth");
const { getBalancePaise, insertEntry } = require("./ledger");
const {
  effectiveMembership,
  loadCardLevelSettings,
} = require("./card_levels");
const {
  appendEventEntry,
  availableEventEntries,
  expireLapsedTopupEntries,
  splitTeamFee,
} = require("./event_entries");
const { normalizeCollegeEmail, sendTestEmail } = require("./email_verification");

const ENTRY_TOPUP_PRICE_PAISE = 29900;

function retryDateForWindow(rows, totalAfterRequest, maximum, windowMs) {
  const excess = totalAfterRequest - maximum;
  if (excess <= 0) return null;
  const ordered = rows
    .map((row) => new Date(row.created_at).getTime())
    .sort((left, right) => left - right);
  const retryAt = (ordered[Math.min(excess - 1, ordered.length - 1)] || Date.now()) + windowMs;
  return new Date(retryAt);
}

function throttledInviteError(retryAt) {
  const retryDate = retryAt || new Date(Date.now() + 60_000);
  const retryAfterSeconds = Math.max(1, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
  return new HttpError(429, "Too many invitations, try again later", {
    retryAt: retryDate.toISOString(),
    retryAfterSeconds,
  });
}

async function reserveTeamInviteAttempts(pool, {
  leaderAccountId,
  requestId,
  recipientEmails,
  clientIp,
}) {
  if (recipientEmails.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockKeys = [
      `team-invites:leader:${leaderAccountId}`,
      `team-invites:ip:${clientIp}`,
      ...recipientEmails.map((email) => `team-invites:recipient:${email}`),
    ].sort();
    for (const lockKey of lockKeys) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
    }

    const existing = await client.query(
      `SELECT recipient_email FROM team_invite_attempts
       WHERE request_id = $1 AND leader_account_id = $2`,
      [requestId, leaderAccountId]
    );
    if (existing.rows.length) {
      const reserved = existing.rows.map((row) => row.recipient_email).sort();
      if (JSON.stringify(reserved) !== JSON.stringify([...recipientEmails].sort())) {
        throw new HttpError(409, "requestId was already used for different invitations");
      }
      await client.query("COMMIT");
      return;
    }

    const settings = await loadCardLevelSettings(client);
    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;
    const proposed = recipientEmails.length;
    const leaderHour = await client.query(
      `SELECT created_at FROM team_invite_attempts
       WHERE leader_account_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at`,
      [leaderAccountId]
    );
    const leaderDay = await client.query(
      `SELECT created_at FROM team_invite_attempts
       WHERE leader_account_id = $1 AND created_at > NOW() - INTERVAL '1 day'
       ORDER BY created_at`,
      [leaderAccountId]
    );
    const ipHour = await client.query(
      `SELECT DISTINCT ON (leader_account_id, request_id) created_at
       FROM team_invite_attempts
       WHERE client_ip = $1 AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY leader_account_id, request_id, created_at`,
      [clientIp]
    );
    let retryAt = null;
    if (leaderHour.rows.length + proposed > Number(settings.team_invites_per_leader_hour)) {
      retryAt = retryDateForWindow(
        leaderHour.rows,
        leaderHour.rows.length + proposed,
        Number(settings.team_invites_per_leader_hour),
        hourMs
      );
    }
    if (leaderDay.rows.length + proposed > Number(settings.team_invites_per_leader_day)) {
      const candidate = retryDateForWindow(
        leaderDay.rows,
        leaderDay.rows.length + proposed,
        Number(settings.team_invites_per_leader_day),
        dayMs
      );
      if (!retryAt || candidate > retryAt) retryAt = candidate;
    }
    if (ipHour.rows.length + 1 > Number(settings.team_invites_per_ip_hour)) {
      const candidate = retryDateForWindow(
        ipHour.rows,
        ipHour.rows.length + 1,
        Number(settings.team_invites_per_ip_hour),
        hourMs
      );
      if (!retryAt || candidate > retryAt) retryAt = candidate;
    }

    for (const email of recipientEmails) {
      const leaderRecipient = await client.query(
        `SELECT created_at FROM team_invite_attempts
         WHERE leader_account_id = $1 AND recipient_email = $2
           AND created_at > NOW() - INTERVAL '1 hour'
         ORDER BY created_at`,
        [leaderAccountId, email]
      );
      const recipientDay = await client.query(
        `SELECT created_at FROM team_invite_attempts
         WHERE recipient_email = $1 AND created_at > NOW() - INTERVAL '1 day'
         ORDER BY created_at`,
        [email]
      );
      const cooldown = Number(settings.team_invite_recipient_cooldown_seconds) * 1000;
      const mostRecent = leaderRecipient.rows.length
        ? new Date(leaderRecipient.rows[leaderRecipient.rows.length - 1].created_at).getTime()
        : 0;
      const cooldownRetry = mostRecent + cooldown;
      if (
        leaderRecipient.rows.length + 1 > Number(settings.team_invites_per_recipient_leader_hour) ||
        (mostRecent > 0 && cooldownRetry > now)
      ) {
        const candidate = leaderRecipient.rows.length + 1 > Number(settings.team_invites_per_recipient_leader_hour)
          ? retryDateForWindow(
            leaderRecipient.rows,
            leaderRecipient.rows.length + 1,
            Number(settings.team_invites_per_recipient_leader_hour),
            hourMs
          )
          : new Date(cooldownRetry);
        if (!retryAt || candidate > retryAt) retryAt = candidate;
      }
      if (recipientDay.rows.length + 1 > Number(settings.team_invites_per_recipient_day)) {
        const candidate = retryDateForWindow(
          recipientDay.rows,
          recipientDay.rows.length + 1,
          Number(settings.team_invites_per_recipient_day),
          dayMs
        );
        if (!retryAt || candidate > retryAt) retryAt = candidate;
      }
    }

    if (retryAt) throw throttledInviteError(retryAt);
    for (const email of recipientEmails) {
      await client.query(
        `INSERT INTO team_invite_attempts
           (id, request_id, leader_account_id, recipient_email, client_ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), requestId, leaderAccountId, email, clientIp]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function validRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new HttpError(400, "requestId must be 8-100 letters, digits, underscores, or hyphens");
  }
  return value;
}

function eventView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    feePaise: Number(row.fee_paise),
    teamSize: Number(row.team_size),
    organizer: {
      collegeId: row.organizer_college_id,
      name: row.organizer_name,
    },
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    cancelledAt: row.cancelled_at,
    registered: row.registered === true,
    registrationId: row.registration_id || null,
  };
}

function allocateEntry(available) {
  if (available.yearlyFreeEntries > 0) return "yearly_free";
  if (available.topUpEntries > 0) return "top_up";
  return null;
}

async function loadEvent(client, eventId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT e.*, a.college_id AS organizer_college_id, a.name AS organizer_name,
            a.role AS organizer_role
     FROM events e JOIN accounts a ON a.id = e.organizer_id
     WHERE e.id = $1 ${lock ? "FOR UPDATE OF e" : ""}`,
    [eventId]
  );
  if (!rows[0]) throw new HttpError(404, "Event not found");
  return rows[0];
}

async function loadActiveMembership(client, student) {
  const settings = await loadCardLevelSettings(client);
  const membership = effectiveMembership(
    student,
    new Date(),
    Number(settings.emberfall_grace_days)
  );
  await expireLapsedTopupEntries(client, student, membership);
  return membership;
}

async function refundAndCancelEvent(client, event) {
  const registrations = await client.query(
    `SELECT * FROM event_registrations
     WHERE event_id = $1 AND status = 'registered'
     ORDER BY id FOR UPDATE`,
    [event.id]
  );
  const registrationIds = registrations.rows.map((row) => row.id);
  const members = registrationIds.length
    ? await client.query(
      `SELECT * FROM event_registration_members
       WHERE registration_id = ANY($1::uuid[])
       ORDER BY account_id, registration_id`,
      [registrationIds]
    )
    : { rows: [] };
  const paybacks = registrationIds.length
    ? await client.query(
      `SELECT * FROM team_payback_requests
       WHERE team_id = ANY($1::uuid[])
       ORDER BY team_id, sender_id`,
      [registrationIds]
    )
    : { rows: [] };

  const accountIds = [...new Set([
    event.organizer_id,
    ...registrations.rows.map((row) => row.leader_account_id),
    ...members.rows.map((row) => row.account_id),
    ...paybacks.rows.flatMap((row) => [row.sender_id, row.recipient_id]),
  ])].sort();
  const lockedAccounts = accountIds.length
    ? await client.query(
      "SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [accountIds]
    )
    : { rows: [] };
  const accountsById = new Map(lockedAccounts.rows.map((row) => [row.id, row]));

  const membersByRegistration = new Map();
  for (const member of members.rows) {
    const group = membersByRegistration.get(member.registration_id) || [];
    group.push(member);
    membersByRegistration.set(member.registration_id, group);
  }

  for (const registration of registrations.rows) {
    const paidPaise = Number(registration.paid_paise);
    if (paidPaise > 0) {
      await insertEntry(client, {
        id: crypto.randomUUID(),
        accountId: registration.leader_account_id,
        amountPaise: paidPaise,
        entryType: "event_refund",
        relatedAccountId: event.organizer_id,
        note: `Refund for cancelled event: ${event.title}`,
      });
      await insertEntry(client, {
        id: crypto.randomUUID(),
        accountId: event.organizer_id,
        amountPaise: -paidPaise,
        entryType: "event_refund",
        relatedAccountId: registration.leader_account_id,
        note: `Refund for cancelled event: ${event.title}`,
      });
    }

    for (const member of membersByRegistration.get(registration.id) || []) {
      if (!member.covered_entry_type) continue;
      const coveredPaise = Number(member.covered_paise);
      if (member.covered_entry_type === "top_up") {
        const account = accountsById.get(member.account_id);
        if (account) {
          const settings = await loadCardLevelSettings(client);
          const membership = effectiveMembership(
            account,
            new Date(),
            Number(settings.emberfall_grace_days)
          );
          if (membership.level !== "EMBERFALL") {
            await expireLapsedTopupEntries(client, account, membership);
            continue;
          }
        }
      }
      await appendEventEntry(client, {
        accountId: member.account_id,
        referenceKey: `event-refund:${registration.id}:${member.id}`,
        entryType: member.covered_entry_type,
        action: "refund",
        quantity: 1,
        costPaise: -coveredPaise,
        membershipRequestId: member.membership_request_id,
        registrationId: registration.id,
      });
      await insertEntry(client, {
        id: crypto.randomUUID(),
        accountId: member.account_id,
        amountPaise: 0,
        costPaise: -coveredPaise,
        entryType: "event_free_entry_refund",
        relatedAccountId: event.organizer_id,
        note: `Free entry returned for cancelled event: ${event.title}`,
      });
    }
    for (const payback of paybacks.rows.filter((row) => row.team_id === registration.id)) {
      await insertEntry(client, {
        id: crypto.randomUUID(),
        accountId: payback.sender_id,
        amountPaise: Number(payback.amount_paise),
        entryType: "team_payback_refund",
        relatedAccountId: payback.recipient_id,
        teamId: registration.id,
        note: `Team payback returned for cancelled event: ${event.title}`,
      });
      await insertEntry(client, {
        id: crypto.randomUUID(),
        accountId: payback.recipient_id,
        amountPaise: -Number(payback.amount_paise),
        entryType: "team_payback_refund",
        relatedAccountId: payback.sender_id,
        teamId: registration.id,
        note: `Team payback refunded for cancelled event: ${event.title}`,
      });
      if (Number(payback.fee_paise) > 0) {
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: payback.sender_id,
          amountPaise: Number(payback.fee_paise),
          entryType: "team_payback_fee_refund",
          teamId: registration.id,
          note: `Team payback fee returned for cancelled event: ${event.title}`,
        });
      }
    }
    await client.query(
      "UPDATE event_registrations SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1",
      [registration.id]
    );
    await client.query(
      "UPDATE team_invites SET revoked_at = NOW() WHERE team_id = $1 AND revoked_at IS NULL",
      [registration.id]
    );
  }
  await client.query(
    "UPDATE events SET cancelled_at = NOW() WHERE id = $1 AND cancelled_at IS NULL",
    [event.id]
  );
}

function mountStudentEventRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");
  const accountAuth = authRequired(config);

  app.get(
    "/events",
    studentAuth,
    asyncHandler(async (req, res) => {
      const events = await pool.query(
        `SELECT e.*, a.college_id AS organizer_college_id, a.name AS organizer_name,
                EXISTS (
                  SELECT 1 FROM event_registration_members arm
                  JOIN event_registrations er ON er.id = arm.registration_id
                  WHERE arm.event_id = e.id AND arm.account_id = $1
                    AND er.status = 'registered'
                ) AS registered,
                (
                  SELECT er.id FROM event_registration_members arm
                  JOIN event_registrations er ON er.id = arm.registration_id
                  WHERE arm.event_id = e.id AND arm.account_id = $1
                    AND er.status = 'registered'
                  LIMIT 1
                ) AS registration_id
         FROM events e
         JOIN accounts a ON a.id = e.organizer_id
         WHERE e.cancelled_at IS NULL AND e.ends_at > NOW()
         ORDER BY e.starts_at, e.created_at`,
        [req.auth.sub]
      );
      res.json({ events: events.rows.map(eventView), testMode: true });
    })
  );

  app.get(
    "/students/event-entries",
    studentAuth,
    asyncHandler(async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const account = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        if (!account.rows[0]) throw new HttpError(404, "Student not found");
        const membership = await loadActiveMembership(client, account.rows[0]);
        const entries = await availableEventEntries(client, account.rows[0].id, membership);
        await client.query("COMMIT");
        res.json({
          cardLevel: membership.level,
          inGracePeriod: membership.inGracePeriod,
          yearlyFreeEntries: entries.yearlyFreeEntries,
          topUpEntries: entries.topUpEntries,
          topUpPricePaise: ENTRY_TOPUP_PRICE_PAISE,
          testMode: true,
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
    "/students/event-entries/top-up",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) throw new HttpError(403, "Event entry top-ups are test-mode only");
      const requestId = validRequestId(req.body?.requestId);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`event-entry-topup:${requestId}`]
        );
        const account = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        const student = account.rows[0];
        if (!student) throw new HttpError(404, "Student not found");
        if (student.frozen) throw new HttpError(403, "Your wallet is frozen");
        const prior = await client.query(
          `SELECT account_id, amount_paise FROM event_entry_topup_requests
           WHERE request_id = $1`,
          [requestId]
        );
        if (prior.rows[0]) {
          if (prior.rows[0].account_id !== student.id) {
            throw new HttpError(409, "requestId was already used for another account");
          }
          const membership = await loadActiveMembership(client, student);
          const entries = await availableEventEntries(client, student.id, membership);
          const balancePaise = await getBalancePaise(client, student.id);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            chargedPaise: Number(prior.rows[0].amount_paise),
            ...entries,
            balancePaise,
          });
        }
        const membership = await loadActiveMembership(client, student);
        if (membership.level !== "EMBERFALL") {
          throw new HttpError(403, "An active EMBERFALL membership is required to buy event entries");
        }
        const balancePaise = await getBalancePaise(client, student.id);
        if (balancePaise < ENTRY_TOPUP_PRICE_PAISE) {
          throw new HttpError(400, "Insufficient wallet balance for an event entry");
        }
        const walletEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: walletEntryId,
          accountId: student.id,
          amountPaise: -ENTRY_TOPUP_PRICE_PAISE,
          entryType: "event_entry_topup",
          note: "Emberfall event entry top-up",
        });
        await client.query(
          `INSERT INTO event_entry_topup_requests
             (request_id, account_id, amount_paise, wallet_entry_id)
           VALUES ($1, $2, $3, $4)`,
          [requestId, student.id, ENTRY_TOPUP_PRICE_PAISE, walletEntryId]
        );
        await appendEventEntry(client, {
          accountId: student.id,
          referenceKey: `event-entry-topup:${requestId}`,
          entryType: "top_up",
          action: "purchase",
          quantity: 1,
          costPaise: ENTRY_TOPUP_PRICE_PAISE,
        });
        const entries = await availableEventEntries(client, student.id, membership);
        await client.query("COMMIT");
        res.json({
          ok: true,
          duplicate: false,
          chargedPaise: ENTRY_TOPUP_PRICE_PAISE,
          ...entries,
          balancePaise: balancePaise - ENTRY_TOPUP_PRICE_PAISE,
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
    "/events/:eventId/register",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) throw new HttpError(403, "Event registration is test-mode only");
      const requestId = validRequestId(req.body?.requestId);
      const suppliedEmails = req.body?.memberEmails;
      if (suppliedEmails !== undefined && !Array.isArray(suppliedEmails)) {
        throw new HttpError(400, "memberEmails must be a list of college email addresses");
      }
      const memberEmails = (suppliedEmails || []).map((email) =>
        normalizeCollegeEmail(email, config.allowedEmailDomains)
      );
      if (new Set(memberEmails).size !== memberEmails.length) {
        throw new HttpError(400, "Each team member must have a different email address");
      }
      const teamName = String(req.body?.teamName || "").trim();
      if (teamName.length > 80 || (memberEmails.length && teamName.length < 2)) {
        throw new HttpError(400, "teamName must be 2-80 characters for a team");
      }
      const eventPreview = await loadEvent(pool, req.params.eventId);
      if (eventPreview.cancelled_at || new Date(eventPreview.ends_at) <= new Date()) {
        throw new HttpError(409, "This event is not accepting registrations");
      }
      const teamSize = Number(eventPreview.team_size);
      if (memberEmails.length + 1 !== teamSize) {
        throw new HttpError(
          400,
          `This event requires a team of ${teamSize}; provide ${teamSize - 1} memberEmails`
        );
      }
      if (memberEmails.length) {
        const { rows: leaderRows } = await pool.query(
          `SELECT email, email_verified_at, frozen
           FROM accounts WHERE id = $1 AND role = 'student'`,
          [req.auth.sub]
        );
        const leaderAccount = leaderRows[0];
        if (!leaderAccount) throw new HttpError(404, "Team leader not found");
        if (!leaderAccount.email_verified_at || !leaderAccount.email) {
          throw new HttpError(403, "Verify your college email before registering a team");
        }
        normalizeCollegeEmail(leaderAccount.email, config.allowedEmailDomains);
        if (leaderAccount.frozen) throw new HttpError(403, "Frozen student accounts cannot register for events");

        const existing = await pool.query(
          "SELECT id, event_id, leader_account_id, paid_paise, team_name FROM event_registrations WHERE request_id = $1",
          [requestId]
        );
        if (existing.rows[0]) {
          const previous = existing.rows[0];
          const previousEmails = await pool.query(
            "SELECT email FROM team_invites WHERE team_id = $1 ORDER BY email",
            [previous.id]
          );
          if (
            previous.leader_account_id !== req.auth.sub ||
            previous.event_id !== eventPreview.id ||
            previous.team_name !== teamName ||
            JSON.stringify(previousEmails.rows.map((row) => row.email).sort()) !== JSON.stringify([...memberEmails].sort())
          ) {
            throw new HttpError(409, "requestId was already used for another registration");
          }
          return res.json({
            ok: true,
            duplicate: true,
            registrationId: previous.id,
            paidPaise: Number(previous.paid_paise),
            balancePaise: await getBalancePaise(pool, req.auth.sub),
          });
        }

        await reserveTeamInviteAttempts(pool, {
          leaderAccountId: req.auth.sub,
          requestId,
          recipientEmails: memberEmails,
          clientIp: req.ip || "unknown",
        });
      }

      const client = await pool.connect();
      const inviteEmails = [];
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`event-registration:${requestId}`]
        );
        const event = await loadEvent(client, req.params.eventId, { lock: true });
        if (event.cancelled_at || new Date(event.ends_at) <= new Date()) {
          throw new HttpError(409, "This event is not accepting registrations");
        }
        if (memberEmails.length + 1 !== Number(event.team_size)) {
          throw new HttpError(
            400,
            `This event requires a team of ${event.team_size}; provide ${Number(event.team_size) - 1} memberEmails`
          );
        }

        const duplicateRequest = await client.query(
          "SELECT * FROM event_registrations WHERE request_id = $1",
          [requestId]
        );
        if (duplicateRequest.rows[0]) {
          const previous = duplicateRequest.rows[0];
          if (previous.leader_account_id !== req.auth.sub || previous.event_id !== event.id) {
            throw new HttpError(409, "requestId was already used for another registration");
          }
          const balancePaise = await getBalancePaise(client, req.auth.sub);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            registrationId: previous.id,
            paidPaise: Number(previous.paid_paise),
            balancePaise,
          });
        }

        const { rows: leaderRows } = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        const leader = leaderRows[0];
        if (!leader) throw new HttpError(404, "Team leader not found");
        if (leader.frozen) throw new HttpError(403, "Frozen student accounts cannot register for events");
        if (memberEmails.length && !leader.email_verified_at) {
          throw new HttpError(403, "Verify your college email before registering a team");
        }
        const alreadyRegistered = await client.query(
          `SELECT arm.account_id
           FROM event_registration_members arm
           JOIN event_registrations er ON er.id = arm.registration_id
           WHERE arm.event_id = $1 AND er.status = 'registered'
             AND arm.account_id = $2`,
          [event.id, leader.id]
        );
        if (alreadyRegistered.rows.length) {
          throw new HttpError(409, "You are already registered for this event");
        }

        const settings = await loadCardLevelSettings(client);
        const shares = splitTeamFee(Number(event.fee_paise), Number(event.team_size));
        const registrationId = crypto.randomUUID();
        const membership = effectiveMembership(
          leader,
          new Date(),
          Number(settings.emberfall_grace_days)
        );
        await expireLapsedTopupEntries(client, leader, membership);
        const available = await availableEventEntries(client, leader.id, membership);
        const leaderEntryType = allocateEntry(available);
        const leaderCoveredPaise = leaderEntryType ? shares[0] : 0;
        if (leaderEntryType) {
          await appendEventEntry(client, {
            accountId: leader.id,
            referenceKey: `event-use:${registrationId}:${leader.id}`,
            entryType: leaderEntryType,
            action: "consume",
            quantity: -1,
            costPaise: leaderCoveredPaise,
            membershipRequestId: available.membershipRequestId,
            registrationId,
          });
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: leader.id,
            amountPaise: 0,
            costPaise: leaderCoveredPaise,
            entryType: "event_free_entry",
            relatedAccountId: event.organizer_id,
            note: `Free entry (${leaderEntryType}): ${event.title}`,
          });
        }

        const paidPaise = Number(event.fee_paise) - leaderCoveredPaise;
        const leaderBalancePaise = await getBalancePaise(client, leader.id);
        if (leaderBalancePaise < paidPaise) {
          throw new HttpError(400, "Insufficient test balance for the event fee");
        }
        const debitEntryId = crypto.randomUUID();
        if (paidPaise > 0) {
          await insertEntry(client, {
            id: debitEntryId,
            accountId: leader.id,
            amountPaise: -paidPaise,
            entryType: "event_registration",
            relatedAccountId: event.organizer_id,
            note: `Event registration: ${event.title}`,
          });
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: event.organizer_id,
            amountPaise: paidPaise,
            entryType: "event_registration",
            relatedAccountId: leader.id,
            note: `Event registration: ${event.title}`,
          });
        }
        await client.query(
          `INSERT INTO event_registrations
               (id, event_id, leader_account_id, request_id, team_fee_paise, paid_paise, team_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            registrationId,
            event.id,
            leader.id,
            requestId,
            event.fee_paise,
            paidPaise,
            teamName || `${leader.name}'s team`,
          ]
        );
        await client.query(
          `INSERT INTO event_registration_members
               (id, registration_id, event_id, account_id, share_paise, covered_paise,
                  covered_entry_type, membership_request_id, payback_due_paise)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
          [
            crypto.randomUUID(),
            registrationId,
            event.id,
            leader.id,
            shares[0],
            leaderCoveredPaise,
            leaderEntryType,
            available.membershipRequestId,
          ]
        );
        await client.query(
          `INSERT INTO team_members
               (team_id, event_id, user_id, share_paise, paid_paise, role)
             VALUES ($1, $2, $3, $4, $4, 'leader')`,
          [registrationId, event.id, leader.id, shares[0]]
        );
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
        for (let index = 0; index < memberEmails.length; index += 1) {
          const email = memberEmails[index];
          const token = crypto.randomBytes(32).toString("base64url");
          await client.query(
            `INSERT INTO team_invites
                 (id, team_id, email, token_hash, share_paise, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              crypto.randomUUID(),
              registrationId,
              email,
              crypto.createHash("sha256").update(token).digest("hex"),
              shares[index + 1],
              expiresAt,
            ]
          );
          inviteEmails.push({
            to: email,
            subject: `Invitation to ${teamName || `${leader.name}'s team`}`,
            text: `You have been invited to join ${teamName || `${leader.name}'s team`} for ${event.title}.\nAccept this single-use invite in Campus Wallet: ${config.publicAppUrl || `http://localhost:${config.port || 3000}`}/team-invites/accept?token=${token}\nThis invite expires in 48 hours.`,
          });
        }
        const { rows: pendingInviteCount } = await client.query(
          `SELECT COUNT(*)::int AS count FROM team_invites
           WHERE team_id = $1 AND used_at IS NULL AND revoked_at IS NULL
             AND expires_at > NOW()`,
          [registrationId]
        );
        if (pendingInviteCount[0].count > Number(event.team_size) - 1) {
          throw new HttpError(409, "A team cannot have more pending invitations than open member seats");
        }

        await client.query("COMMIT");
        for (const message of inviteEmails) await sendTestEmail(config, message);
        res.status(201).json({
          ok: true,
          registrationId,
          eventId: event.id,
          teamName: teamName || `${leader.name}'s team`,
          teamFeePaise: Number(event.fee_paise),
          paidPaise,
          leaderCoveredPaise,
          members: [
            {
              collegeId: leader.college_id,
              email: leader.email,
              sharePaise: shares[0],
              coveredPaise: leaderCoveredPaise,
              entryType: leaderEntryType,
              paybackDuePaise: 0,
              role: "leader",
            },
            ...memberEmails.map((email, index) => ({
              email,
              sharePaise: shares[index + 1],
              coveredPaise: 0,
              paybackDuePaise: shares[index + 1],
              invitationPending: true,
              role: "member",
            })),
          ],
          balancePaise: leaderBalancePaise - paidPaise,
          testMode: true,
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
    "/events/:eventId/cancel",
    accountAuth,
    asyncHandler(async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const event = await loadEvent(client, req.params.eventId, { lock: true });
        if (event.organizer_id !== req.auth.sub) {
          throw new HttpError(403, "Only this event's organizer can cancel it");
        }
        if (event.cancelled_at) {
          await client.query("COMMIT");
          return res.json({ ok: true, duplicate: true, refundedRegistrations: 0 });
        }
        await refundAndCancelEvent(client, event);
        await client.query("COMMIT");
        res.json({ ok: true, refundedRegistrations: "all", testMode: true });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.post(
    "/students/teams/:teamId/invites/resend",
    studentAuth,
    asyncHandler(async (req, res) => {
      if (!config.testMode) throw new HttpError(403, "Team invitations are test-mode only");
      const requestId = validRequestId(req.body?.requestId);
      const email = normalizeCollegeEmail(req.body?.email, config.allowedEmailDomains);
      const { rows: previewRows } = await pool.query(
        `SELECT er.event_id, er.leader_account_id, er.team_name, er.status,
                e.title, e.team_size, e.cancelled_at
         FROM event_registrations er
         JOIN events e ON e.id = er.event_id
         WHERE er.id = $1`,
        [req.params.teamId]
      );
      const preview = previewRows[0];
      if (!preview || preview.leader_account_id !== req.auth.sub) {
        throw new HttpError(404, "Team invitation unavailable");
      }
      if (preview.status !== "registered" || preview.cancelled_at) {
        throw new HttpError(409, "Team invitations are unavailable for cancelled teams");
      }
      const resendRequestId = `resend:${requestId}`;
      const previousAttempt = await pool.query(
        `SELECT recipient_email FROM team_invite_attempts
         WHERE request_id = $1 AND leader_account_id = $2`,
        [resendRequestId, req.auth.sub]
      );
      if (previousAttempt.rows.length) {
        if (previousAttempt.rows.length !== 1 || previousAttempt.rows[0].recipient_email !== email) {
          throw new HttpError(409, "requestId was already used for another invitation");
        }
        return res.json({ ok: true, duplicate: true });
      }
      const { rows: inviteRows } = await pool.query(
        `SELECT id FROM team_invites
         WHERE team_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [req.params.teamId, email]
      );
      if (!inviteRows[0]) throw new HttpError(404, "Team invitation unavailable");
      await reserveTeamInviteAttempts(pool, {
        leaderAccountId: req.auth.sub,
        requestId: resendRequestId,
        recipientEmails: [email],
        clientIp: req.ip || "unknown",
      });

      const client = await pool.connect();
      let message;
      try {
        await client.query("BEGIN");
        const { rows: teamRows } = await client.query(
          `SELECT er.id, er.status, er.team_name, er.leader_account_id,
                  e.id AS event_id, e.title, e.team_size, e.cancelled_at
           FROM event_registrations er
           JOIN events e ON e.id = er.event_id
           WHERE er.id = $1
           FOR UPDATE OF er`,
          [req.params.teamId]
        );
        const team = teamRows[0];
        if (!team || team.leader_account_id !== req.auth.sub || team.status !== "registered" || team.cancelled_at) {
          throw new HttpError(404, "Team invitation unavailable");
        }
        const { rows: existingInvites } = await client.query(
          `SELECT * FROM team_invites
           WHERE team_id = $1 AND email = $2
             AND used_at IS NULL AND revoked_at IS NULL
           ORDER BY created_at DESC
           FOR UPDATE`,
          [team.id, email]
        );
        if (existingInvites.length !== 1) {
          throw new HttpError(404, "Team invitation unavailable");
        }
        const token = crypto.randomBytes(32).toString("base64url");
        await client.query(
          "UPDATE team_invites SET revoked_at = NOW() WHERE id = $1",
          [existingInvites[0].id]
        );
        await client.query(
          `INSERT INTO team_invites (id, team_id, email, token_hash, share_paise, expires_at)
           VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '48 hours')`,
          [
            crypto.randomUUID(),
            team.id,
            email,
            crypto.createHash("sha256").update(token).digest("hex"),
            existingInvites[0].share_paise,
          ]
        );
        const { rows: pendingRows } = await client.query(
          `SELECT COUNT(*)::int AS count FROM team_invites
           WHERE team_id = $1 AND used_at IS NULL AND revoked_at IS NULL
             AND expires_at > NOW()`,
          [team.id]
        );
        if (pendingRows[0].count > Number(team.team_size) - 1) {
          throw new HttpError(409, "A team cannot have more pending invitations than open member seats");
        }
        message = {
          to: email,
          subject: `Invitation to ${team.team_name}`,
          text: `You have been invited to join ${team.team_name} for ${team.title}.\nAccept this single-use invite in Campus Wallet: ${config.publicAppUrl || `http://localhost:${config.port || 3000}`}/team-invites/accept?token=${token}\nThis invite expires in 48 hours.`,
        };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await sendTestEmail(config, message);
      res.json({ ok: true, duplicate: false, testMode: true });
    })
  );
}

function mountAdminEventRoutes(app, { pool, config }) {
  app.post(
    "/admin/events",
    asyncHandler(async (req, res) => {
      if (!config.testMode) throw new HttpError(403, "Event creation is available only in test mode");
      const title = String(req.body?.title || "").trim();
      const description = String(req.body?.description || "").trim();
      const feePaise = req.body?.feePaise;
      const teamSize = req.body?.teamSize ?? 1;
      const organizerCollegeId = assertCollegeId(req.body?.organizerCollegeId);
      const startsAt = new Date(req.body?.startsAt);
      const endsAt = new Date(req.body?.endsAt);
      if (title.length < 2 || title.length > 120) {
        throw new HttpError(400, "title must be 2-120 characters");
      }
      if (description.length > 2000) throw new HttpError(400, "description is too long");
      if (!Number.isSafeInteger(feePaise) || feePaise <= 0) {
        throw new HttpError(400, "feePaise must be a positive integer");
      }
      if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 4) {
        throw new HttpError(400, "teamSize must be an integer between 1 and 4");
      }
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
        throw new HttpError(400, "Provide valid event dates with endsAt after startsAt");
      }
      const organizer = await pool.query(
        "SELECT id FROM accounts WHERE college_id = $1 AND role = 'merchant'",
        [organizerCollegeId]
      );
      if (!organizer.rows[0]) {
        throw new HttpError(404, "Event organizer must be a registered canteen/merchant account");
      }
      const id = crypto.randomUUID();
      const result = await pool.query(
        `INSERT INTO events
           (id, title, description, fee_paise, team_size, organizer_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          id,
          title,
          description,
          feePaise,
          teamSize,
          organizer.rows[0].id,
          startsAt.toISOString(),
          endsAt.toISOString(),
        ]
      );
      const event = await loadEvent(pool, result.rows[0].id);
      res.status(201).json({ ok: true, event: eventView(event), testMode: true });
    })
  );

  app.get(
    "/admin/events",
    asyncHandler(async (_req, res) => {
      const { rows } = await pool.query(
        `SELECT e.*, a.college_id AS organizer_college_id, a.name AS organizer_name
         FROM events e
         JOIN accounts a ON a.id = e.organizer_id
         ORDER BY e.created_at DESC`
      );
      res.json({ events: rows.map(eventView), testMode: true });
    })
  );

  app.post(
    "/admin/events/:eventId/cancel",
    asyncHandler(async (req, res) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const event = await loadEvent(client, req.params.eventId, { lock: true });
        if (event.cancelled_at) {
          await client.query("COMMIT");
          return res.json({ ok: true, duplicate: true, testMode: true });
        }
        await refundAndCancelEvent(client, event);
        await client.query("COMMIT");
        res.json({ ok: true, testMode: true });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    "/admin/events/:eventId/registrations",
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT er.id, er.request_id, er.team_fee_paise, er.paid_paise, er.status,
                er.created_at, leader.college_id AS leader_college_id,
                arm.account_id, member.college_id, member.name,
                arm.share_paise, arm.covered_paise, arm.covered_entry_type,
                arm.payback_due_paise
         FROM event_registrations er
         JOIN accounts leader ON leader.id = er.leader_account_id
         JOIN event_registration_members arm ON arm.registration_id = er.id
         JOIN accounts member ON member.id = arm.account_id
         WHERE er.event_id = $1
         ORDER BY er.created_at, arm.created_at`,
        [req.params.eventId]
      );
      res.json({
        registrations: rows.map((row) => ({
          registrationId: row.id,
          requestId: row.request_id,
          leaderCollegeId: row.leader_college_id,
          teamFeePaise: Number(row.team_fee_paise),
          paidPaise: Number(row.paid_paise),
          status: row.status,
          createdAt: row.created_at,
          member: {
            collegeId: row.college_id,
            name: row.name,
            sharePaise: Number(row.share_paise),
            coveredPaise: Number(row.covered_paise),
            coveredEntryType: row.covered_entry_type,
            paybackDuePaise: Number(row.payback_due_paise),
          },
        })),
        testMode: true,
      });
    })
  );
}

module.exports = {
  ENTRY_TOPUP_PRICE_PAISE,
  mountAdminEventRoutes,
  mountStudentEventRoutes,
  splitTeamFee,
};
