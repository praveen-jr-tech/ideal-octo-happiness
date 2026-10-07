const crypto = require("crypto");
const { HttpError } = require("./db");
const { asyncHandler, authRequired, verifyPin } = require("./auth");
const { effectiveMembership, loadCardLevelSettings, transferQuote } = require("./card_levels");
const { getBalancePaise, insertEntry } = require("./ledger");
const {
  appendEventEntry,
  availableEventEntries,
  expireLapsedTopupEntries,
} = require("./event_entries");
const { sendTestEmail } = require("./email_verification");

function validRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new HttpError(400, "requestId must be 8-100 letters, digits, underscores, or hyphens");
  }
  return value;
}

function invalidInvite() {
  return new HttpError(404, "Invitation invalid or unavailable");
}

function requireTestMode(config) {
  if (!config.testMode) throw new HttpError(403, "Team features are available only in local test mode");
}

function allocateEntry(available) {
  if (available.yearlyFreeEntries > 0) return "yearly_free";
  if (available.topUpEntries > 0) return "top_up";
  return null;
}

function mountStudentTeamRoutes(app, { pool, config }) {
  const studentAuth = authRequired(config, "student");

  app.get(
    "/team-invites/accept",
    asyncHandler(async (req, res) => {
      const token = String(req.query.token || "");
      if (token.length < 32 || token.length > 100) throw invalidInvite();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const { rows } = await pool.query(
        `SELECT ti.expires_at, ti.used_at, ti.revoked_at, er.status, e.cancelled_at
         FROM team_invites ti
         JOIN event_registrations er ON er.id = ti.team_id
         JOIN events e ON e.id = er.event_id
         WHERE ti.token_hash = $1`,
        [tokenHash]
      );
      const invite = rows[0];
      if (
        !invite ||
        invite.used_at ||
        invite.revoked_at ||
        new Date(invite.expires_at) <= new Date() ||
        invite.status !== "registered" ||
        invite.cancelled_at
      ) {
        throw invalidInvite();
      }
      res.type("text/plain").send(
        `This team invitation is valid. Sign in to Campus Wallet, open Events, choose Accept invitation, and enter this token:\n${token}`
      );
    })
  );

  app.post(
    "/students/team-invites/accept",
    studentAuth,
    asyncHandler(async (req, res) => {
      requireTestMode(config);
      const token = String(req.body?.token || "");
      if (token.length < 32 || token.length > 100) throw invalidInvite();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`team-invite-token:${tokenHash}`]
        );
        const { rows: inviteRows } = await client.query(
          "SELECT * FROM team_invites WHERE token_hash = $1 FOR UPDATE",
          [tokenHash]
        );
        const invite = inviteRows[0];
        if (
          !invite ||
          invite.used_at ||
          invite.revoked_at ||
          new Date(invite.expires_at) <= new Date()
        ) {
          throw invalidInvite();
        }
        const { rows: previewRows } = await client.query(
          `SELECT er.event_id FROM event_registrations er WHERE er.id = $1`,
          [invite.team_id]
        );
        if (!previewRows[0]) throw invalidInvite();
        await client.query(
          "SELECT id FROM events WHERE id = $1 FOR UPDATE",
          [previewRows[0].event_id]
        );
        const { rows: teamRows } = await client.query(
          `SELECT er.*, e.title, e.cancelled_at AS event_cancelled_at
           FROM event_registrations er
           JOIN events e ON e.id = er.event_id
           WHERE er.id = $1
           FOR UPDATE OF er`,
          [invite.team_id]
        );
        const team = teamRows[0];
        if (!team || team.status !== "registered" || team.event_cancelled_at) {
          throw invalidInvite();
        }
        const { rows: accountRows } = await client.query(
          "SELECT * FROM accounts WHERE id = $1 AND role = 'student' FOR UPDATE",
          [req.auth.sub]
        );
        const student = accountRows[0];
        if (
          !student ||
          !student.email_verified_at ||
          !student.email ||
          student.email.toLowerCase() !== invite.email
        ) {
          throw invalidInvite();
        }
        if (student.frozen) throw new HttpError(403, "Frozen student accounts cannot join a team");
        const occupied = await client.query(
          "SELECT 1 FROM team_members WHERE event_id = $1 AND user_id = $2",
          [team.event_id, student.id]
        );
        if (occupied.rows.length) {
          throw new HttpError(409, "You already belong to a team for this event");
        }

        const settings = await loadCardLevelSettings(client);
        const membership = effectiveMembership(
          student,
          new Date(),
          Number(settings.emberfall_grace_days)
        );
        await expireLapsedTopupEntries(client, student, membership);
        const available = await availableEventEntries(client, student.id, membership);
        const entryType = allocateEntry(available);
        const coveredPaise = entryType ? Number(invite.share_paise) : 0;
        if (entryType) {
          await appendEventEntry(client, {
            accountId: student.id,
            referenceKey: `event-use:${team.id}:${student.id}`,
            entryType,
            action: "consume",
            quantity: -1,
            costPaise: coveredPaise,
            membershipRequestId: available.membershipRequestId,
            registrationId: team.id,
          });
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: student.id,
            amountPaise: 0,
            costPaise: coveredPaise,
            entryType: "event_free_entry",
            relatedAccountId: null,
            note: `Free entry (${entryType}): ${team.title}`,
            teamId: team.id,
          });
        }

        await client.query(
          `INSERT INTO team_members
             (team_id, event_id, user_id, share_paise, paid_paise, role)
           VALUES ($1, $2, $3, $4, $5, 'member')`,
          [team.id, team.event_id, student.id, invite.share_paise, coveredPaise]
        );
        await client.query(
          `INSERT INTO event_registration_members
             (id, registration_id, event_id, account_id, share_paise, covered_paise,
                covered_entry_type, membership_request_id, payback_due_paise)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            crypto.randomUUID(),
            team.id,
            team.event_id,
            student.id,
            invite.share_paise,
            coveredPaise,
            entryType,
            available.membershipRequestId,
            Number(invite.share_paise) - coveredPaise,
          ]
        );
        await client.query(
          `UPDATE team_invites SET used_at = NOW(), accepted_user_id = $2
           WHERE id = $1`,
          [invite.id, student.id]
        );
        await client.query("COMMIT");
        res.json({
          ok: true,
          teamId: team.id,
          teamName: team.team_name,
          eventTitle: team.title,
          sharePaise: Number(invite.share_paise),
          coveredPaise,
          paybackDuePaise: Number(invite.share_paise) - coveredPaise,
          entryType,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        if (error.code === "23505") throw new HttpError(409, "You already belong to a team for this event");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    "/students/teams",
    studentAuth,
    asyncHandler(async (req, res) => {
      const { rows: teams } = await pool.query(
        `SELECT er.id AS team_id, er.team_name, er.team_fee_paise, er.paid_paise AS leader_paid_paise,
                er.status, er.created_at, e.id AS event_id, e.title AS event_title,
                e.cancelled_at AS event_cancelled_at,
                leader.college_id AS leader_college_id, leader.name AS leader_name
         FROM event_registrations er
         JOIN events e ON e.id = er.event_id
         JOIN accounts leader ON leader.id = er.leader_account_id
         WHERE er.leader_account_id = $1
            OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = er.id AND tm.user_id = $1)
         ORDER BY er.created_at DESC`,
        [req.auth.sub]
      );
      const result = [];
      for (const team of teams) {
        const { rows: members } = await pool.query(
          `SELECT tm.user_id, tm.role, tm.share_paise, tm.paid_paise, tm.payback_count,
                  a.college_id, a.name, a.email, a.card_level, a.card_level_expires_at,
                  a.card_level_fallback, a.frozen
           FROM team_members tm
           JOIN accounts a ON a.id = tm.user_id
           WHERE tm.team_id = $1
           ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, a.college_id`,
          [team.team_id]
        );
        const invites = team.leader_college_id === req.auth.collegeId
          ? (await pool.query(
            `SELECT email, share_paise, expires_at, used_at,
                    (used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()) AS pending
             FROM team_invites WHERE team_id = $1 ORDER BY email`,
            [team.team_id]
          )).rows
          : [];
        result.push({
          teamId: team.team_id,
          teamName: team.team_name,
          eventId: team.event_id,
          eventTitle: team.event_title,
          status: team.event_cancelled_at ? "cancelled" : team.status,
          teamFeePaise: Number(team.team_fee_paise),
          leaderPaidPaise: Number(team.leader_paid_paise),
          leaderCollegeId: team.leader_college_id,
          leaderName: team.leader_name,
          isLeader: team.leader_college_id === req.auth.collegeId,
          members: members.map((member) => ({
            collegeId: member.college_id,
            name: member.name,
            role: member.role,
            sharePaise: Number(member.share_paise),
            paidPaise: Number(member.paid_paise),
            duePaise: Number(member.share_paise) - Number(member.paid_paise),
            paybackCount: Number(member.payback_count),
            frozen: member.frozen,
          })),
          invites: invites.map((invite) => ({
            email: invite.email,
            sharePaise: Number(invite.share_paise),
            expiresAt: invite.expires_at,
            pending: invite.pending,
            accepted: Boolean(invite.used_at),
          })),
        });
      }
      res.json({ teams: result, testMode: true });
    })
  );

  app.post(
    "/students/teams/:teamId/payback",
    studentAuth,
    asyncHandler(async (req, res) => {
      requireTestMode(config);
      const requestId = validRequestId(req.body?.requestId);
      const amountPaise = req.body?.amountPaise;
      const pin = req.body?.pin;
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new HttpError(400, "amountPaise must be a positive integer");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`team-payback-request:${requestId}`]
        );
        const { rows: previousRows } = await client.query(
          "SELECT * FROM team_payback_requests WHERE request_id = $1",
          [requestId]
        );
        if (previousRows[0]) {
          const previous = previousRows[0];
          if (
            previous.sender_id !== req.auth.sub ||
            previous.team_id !== req.params.teamId ||
            Number(previous.amount_paise) !== amountPaise
          ) {
            throw new HttpError(409, "requestId was already used for a different payback");
          }
          const balancePaise = await getBalancePaise(client, req.auth.sub);
          await client.query("COMMIT");
          return res.json({
            ok: true,
            duplicate: true,
            teamId: previous.team_id,
            amountPaise,
            feePaise: Number(previous.fee_paise),
            balancePaise,
          });
        }

        const { rows: teamPreview } = await client.query(
          "SELECT event_id FROM event_registrations WHERE id = $1",
          [req.params.teamId]
        );
        if (!teamPreview[0]) throw new HttpError(404, "Team not found");
        await client.query(
          "SELECT id FROM events WHERE id = $1 FOR UPDATE",
          [teamPreview[0].event_id]
        );
        const { rows: teamRows } = await client.query(
          `SELECT er.*, e.title, e.cancelled_at AS event_cancelled_at
           FROM event_registrations er
           JOIN events e ON e.id = er.event_id
           WHERE er.id = $1
           FOR UPDATE OF er`,
          [req.params.teamId]
        );
        const team = teamRows[0];
        if (!team || team.status !== "registered" || team.event_cancelled_at) {
          throw new HttpError(409, "Team payback is unavailable for this team");
        }
        const { rows: memberRows } = await client.query(
          `SELECT * FROM team_members
           WHERE team_id = $1 AND user_id = $2 AND role = 'member'
           FOR UPDATE`,
          [team.id, req.auth.sub]
        );
        const member = memberRows[0];
        if (!member) throw new HttpError(403, "Only an accepted team member can pay back the leader");
        const leaderId = team.leader_account_id;
        const { rows: accounts } = await client.query(
          `SELECT * FROM accounts
           WHERE id = ANY($1::uuid[]) AND role = 'student'
           ORDER BY id FOR UPDATE`,
          [[req.auth.sub, leaderId]]
        );
        const sender = accounts.find((account) => account.id === req.auth.sub);
        const leader = accounts.find((account) => account.id === leaderId);
        if (!sender || !leader) throw new HttpError(404, "Team member or leader not found");
        if (!verifyPin(pin, sender.pin_hash)) throw new HttpError(401, "Wrong PIN");
        if (sender.frozen || leader.frozen) throw new HttpError(403, "Frozen accounts cannot make team paybacks");
        const duePaise = Number(member.share_paise) - Number(member.paid_paise);
        if (amountPaise > duePaise) throw new HttpError(400, "Payback cannot exceed your remaining team share");

        const settings = await loadCardLevelSettings(client);
        const membership = effectiveMembership(
          sender,
          new Date(),
          Number(settings.emberfall_grace_days)
        );
        if (membership.level === "STARROW" && Number(member.payback_count) > 0) {
          throw new HttpError(409, "STARROW members may make only one payback per team");
        }
        const quote = transferQuote({
          cardLevel: membership.level,
          amountPaise,
          settings,
          purpose: "hackathon_payback",
        });
        const balancePaise = await getBalancePaise(client, sender.id);
        if (balancePaise < quote.totalDebitPaise) {
          throw new HttpError(400, "Insufficient test balance including the payback fee");
        }
        const senderEntryId = crypto.randomUUID();
        await insertEntry(client, {
          id: senderEntryId,
          accountId: sender.id,
          amountPaise: -amountPaise,
          entryType: "team_payback",
          relatedAccountId: leader.id,
          teamId: team.id,
          note: `Team payback to ${leader.name}: ${team.team_name}`,
        });
        await insertEntry(client, {
          id: crypto.randomUUID(),
          accountId: leader.id,
          amountPaise,
          entryType: "team_payback",
          relatedAccountId: sender.id,
          teamId: team.id,
          note: `Team payback from ${sender.name}: ${team.team_name}`,
        });
        if (quote.feePaise > 0) {
          await insertEntry(client, {
            id: crypto.randomUUID(),
            accountId: sender.id,
            amountPaise: -quote.feePaise,
            entryType: "transfer_fee",
            teamId: team.id,
            note: `Team payback fee (${membership.level})`,
          });
        }
        await client.query(
          `INSERT INTO team_payback_requests
             (request_id, team_id, sender_id, recipient_id, amount_paise, fee_paise, sender_entry_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [requestId, team.id, sender.id, leader.id, amountPaise, quote.feePaise, senderEntryId]
        );
        await client.query(
          `UPDATE team_members
           SET paid_paise = paid_paise + $3, payback_count = payback_count + 1
           WHERE team_id = $1 AND user_id = $2`,
          [team.id, sender.id, amountPaise]
        );
        await client.query(
          `UPDATE event_registration_members
           SET payback_due_paise = GREATEST(0, payback_due_paise - $3)
           WHERE registration_id = $1 AND account_id = $2`,
          [team.id, sender.id, amountPaise]
        );
        await client.query("COMMIT");
        res.json({
          ok: true,
          duplicate: false,
          teamId: team.id,
          amountPaise,
          feePaise: quote.feePaise,
          totalDebitPaise: quote.totalDebitPaise,
          remainingDuePaise: duePaise - amountPaise,
          recipient: { collegeId: leader.college_id, name: leader.name },
          balancePaise: balancePaise - quote.totalDebitPaise,
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
    "/students/teams/:teamId/remind",
    studentAuth,
    asyncHandler(async (req, res) => {
      requireTestMode(config);
      const memberId = String(req.body?.memberCollegeId || "").trim().toUpperCase();
      const client = await pool.connect();
      let reminder;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `SELECT er.id, er.team_name, er.status, e.cancelled_at,
                  leader.id AS leader_id, leader.college_id AS leader_college_id,
                  member.id AS member_id, member.name AS member_name, member.email,
                  tm.share_paise, tm.paid_paise
           FROM event_registrations er
           JOIN events e ON e.id = er.event_id
           JOIN accounts leader ON leader.id = er.leader_account_id
           JOIN team_members tm ON tm.team_id = er.id AND tm.role = 'member'
           JOIN accounts member ON member.id = tm.user_id
           WHERE er.id = $1 AND leader.id = $2 AND member.college_id = $3
           FOR UPDATE OF er, tm`,
          [req.params.teamId, req.auth.sub, memberId]
        );
        const row = rows[0];
        if (!row) throw new HttpError(404, "Team member not found");
        if (row.status !== "registered" || row.cancelled_at) {
          throw new HttpError(409, "Reminders are unavailable for cancelled teams");
        }
        const duePaise = Number(row.share_paise) - Number(row.paid_paise);
        if (duePaise <= 0) throw new HttpError(409, "This team member has no remaining payback");
        if (!row.email) throw new HttpError(409, "This team member has no verified email");
        await client.query(
          `INSERT INTO team_reminders (id, team_id, leader_id, member_id)
           VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), row.id, row.leader_id, row.member_id]
        );
        reminder = {
          to: row.email,
          subject: `Team payback reminder: ${row.team_name}`,
          text: `Your remaining share for ${row.team_name} is Rs ${(duePaise / 100).toFixed(2)}. Open Campus Wallet to complete the team payback.`,
        };
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await sendTestEmail(config, reminder);
      res.json({ ok: true, reminded: memberId, testMode: true });
    })
  );
}

module.exports = { mountStudentTeamRoutes };
