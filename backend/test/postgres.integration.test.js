const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createApp } = require("../src/app");
const { createPool } = require("../src/db");

const databaseUrl = process.env.CAMPUS_WALLET_TEST_DATABASE_URL;
const config = {
  port: 0,
  jwtSecret: "campus-wallet-integration-test-secret",
  adminKey: "campus-wallet-integration-test-admin",
  testMode: true,
  qrTtlSeconds: 45,
  allowedEmailDomains: ["example.edu"],
};
const emailOutbox = [];
config.emailLogger = (message) => emailOutbox.push(message);
const pool = databaseUrl ? createPool(databaseUrl) : null;
const app = pool ? createApp({ pool, config }) : null;
const suffix = crypto.randomBytes(5).toString("hex").toUpperCase();
let server;
let baseUrl;
let fixtureIndex = 0;

async function call(method, route, { token, adminKey, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers["x-admin-key"] = adminKey;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

function nextCollegeId(role) {
  fixtureIndex += 1;
  return `${role}${suffix}${fixtureIndex}`;
}

async function createStudent(name = "Integration Student", { verifyEmail = true } = {}) {
  const collegeId = nextCollegeId("STU");
  const email = `${collegeId.toLowerCase()}@example.edu`;
  const signup = await call("POST", "/students/signup", {
    body: { collegeId, name, pin: "1234", email },
  });
  assert.equal(signup.status, 201, JSON.stringify(signup.data));
  if (verifyEmail) {
    const message = emailOutbox[emailOutbox.length - 1];
    assert.equal(message.to, email);
    const code = message.text.match(/\b(\d{6})\b/)[1];
    const verified = await call("POST", "/students/email-verification/confirm", {
      token: signup.data.token,
      body: { code },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
  }
  const login = await call("POST", "/students/login", {
    body: { collegeId, pin: "1234" },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.account.balancePaise, 0);
  return { collegeId, email, token: login.data.token };
}

function latestInviteToken(email) {
  const message = [...emailOutbox].reverse().find((item) => item.to === email && item.subject.startsWith("Invitation to "));
  assert.ok(message, `No invitation email was logged for ${email}`);
  const token = message.text.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, "Invitation email did not contain a token link");
  return token;
}

async function createMerchant(name = "Integration Canteen") {
  const collegeId = nextCollegeId("CAN");
  const created = await call("POST", "/admin/create-merchant", {
    adminKey: config.adminKey,
    body: { collegeId, name, pin: "1234" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const login = await call("POST", "/merchants/login", {
    body: { collegeId, pin: "1234" },
  });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { collegeId, token: login.data.token };
}

async function createEvent(organizerCollegeId, {
  title = "Integration Campus Event",
  feePaise = 10000,
  teamSize = 1,
} = {}) {
  const start = new Date(Date.now() + 86400000);
  const created = await call("POST", "/admin/events", {
    adminKey: config.adminKey,
    body: {
      title,
      feePaise,
      teamSize,
      organizerCollegeId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 86400000).toISOString(),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data.event;
}

async function registerTeam(leader, organizer, {
  memberEmails,
  teamName = "Integration Team",
  title = "Integration Team Event",
  feePaise = 10000,
  teamSize = memberEmails.length + 1,
  requestId = `TEAM_${crypto.randomUUID().replaceAll("-", "")}`,
} = {}) {
  const event = await createEvent(organizer.collegeId, { title, feePaise, teamSize });
  const result = await call("POST", `/events/${event.id}/register`, {
    token: leader.token,
    body: { requestId, teamName, memberEmails },
  });
  return { event, result };
}

async function acceptTeamInvite(student, email = student.email) {
  return call("POST", "/students/team-invites/accept", {
    token: student.token,
    body: { token: latestInviteToken(email) },
  });
}

async function setInviteSettings(overrides = {}) {
  const values = {
    team_invites_per_leader_hour: 10,
    team_invites_per_leader_day: 30,
    team_invites_per_recipient_leader_hour: 3,
    team_invite_recipient_cooldown_seconds: 60,
    team_invites_per_recipient_day: 5,
    team_invites_per_ip_hour: 30,
    ...overrides,
  };
  await pool.query(
    `UPDATE card_level_settings SET
       team_invites_per_leader_hour = $1,
       team_invites_per_leader_day = $2,
       team_invites_per_recipient_leader_hour = $3,
       team_invite_recipient_cooldown_seconds = $4,
       team_invites_per_recipient_day = $5,
       team_invites_per_ip_hour = $6
     WHERE id = 1`,
    [
      values.team_invites_per_leader_hour,
      values.team_invites_per_leader_day,
      values.team_invites_per_recipient_leader_hour,
      values.team_invite_recipient_cooldown_seconds,
      values.team_invites_per_recipient_day,
      values.team_invites_per_ip_hour,
    ]
  );
}

async function buyEmberfall(token) {
  const result = await call("POST", "/students/card-levels/purchase", {
    token,
    body: {
      level: "EMBERFALL",
      period: "year",
      requestId: `EMBERFALL_${crypto.randomUUID().replaceAll("-", "")}`,
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

async function topUp(token, amountPaise = 100000) {
  let remaining = amountPaise;
  let balancePaise = 0;
  while (remaining > 0) {
    const creditPaise = Math.min(remaining, 100000);
    const result = await call("POST", "/students/test-topup", {
      token,
      body: { amountPaise: creditPaise },
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    balancePaise = result.data.account.balancePaise;
    remaining -= creditPaise;
  }
  return balancePaise;
}

async function membershipQuote(token, route, amountPaise = 10000) {
  return call("POST", route, { token, body: { amountPaise } });
}

before(async () => {
  if (!pool) return;
  const { rows } = await pool.query("SELECT current_database() AS name");
  assert.equal(
    rows[0].name,
    "campus_wallet",
    "Integration tests must use the local campus_wallet database"
  );
  const schema = await fs.readFile(path.join(__dirname, "..", "schema.sql"), "utf8");
  await pool.query(schema);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (pool) await pool.end();
});

test(
  "PostgreSQL-backed Campus Wallet critical flows",
  { skip: !databaseUrl },
  async (t) => {
    await t.test("college email verification normalizes uppercase input and locks after five wrong codes", async () => {
      const collegeId = nextCollegeId("STU");
      const email = `${collegeId.toLowerCase()}@EXAMPLE.EDU`;
      const signup = await call("POST", "/students/signup", {
        body: { collegeId, name: "Email Verification Student", pin: "1234", email },
      });
      assert.equal(signup.status, 201, JSON.stringify(signup.data));
      assert.equal(signup.data.account.email, email.toLowerCase());
      assert.equal(signup.data.account.emailVerified, false);
      const stored = await pool.query(
        "SELECT email, email_verified_at FROM accounts WHERE college_id = $1",
        [collegeId]
      );
      assert.equal(stored.rows[0].email, email.toLowerCase());
      assert.equal(stored.rows[0].email_verified_at, null);

      const code = emailOutbox[emailOutbox.length - 1].text.match(/\b(\d{6})\b/)[1];
      const wrongCode = code === "999999" ? "999998" : "999999";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const invalid = await call("POST", "/students/email-verification/confirm", {
          token: signup.data.token,
          body: { code: wrongCode },
        });
        assert.equal(invalid.status, 400);
      }
      const locked = await call("POST", "/students/email-verification/confirm", {
        token: signup.data.token,
        body: { code },
      });
      assert.equal(locked.status, 400);
      const attempts = await pool.query(
        "SELECT attempts FROM email_verification_codes WHERE account_id = (SELECT id FROM accounts WHERE college_id = $1)",
        [collegeId]
      );
      assert.equal(attempts.rows[0].attempts, 5);

      const expiredStudent = await createStudent("Expired Email Code Student", { verifyEmail: false });
      await pool.query(
        `UPDATE email_verification_codes SET expires_at = NOW() - INTERVAL '1 second'
         WHERE account_id = (SELECT id FROM accounts WHERE college_id = $1)`,
        [expiredStudent.collegeId]
      );
      const expiredCode = emailOutbox[emailOutbox.length - 1].text.match(/\b(\d{6})\b/)[1];
      const expiredVerification = await call("POST", "/students/email-verification/confirm", {
        token: expiredStudent.token,
        body: { code: expiredCode },
      });
      assert.equal(expiredVerification.status, 400);
    });

    await t.test("email changes require a fresh verification and retain team memberships", async () => {
      await setInviteSettings();
      const leader = await createStudent("Email Change Team Leader");
      const member = await createStudent("Email Change Member");
      const organizer = await createMerchant("Email Change Organizer");
      await topUp(leader.token, 20000);
      const created = await registerTeam(leader, organizer, {
        memberEmails: [member.email],
        title: "Email Change Membership Event",
      });
      assert.equal(created.result.status, 201, JSON.stringify(created.result.data));
      const accepted = await acceptTeamInvite(member);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      const newEmail = `changed-${member.collegeId.toLowerCase()}@example.edu`;
      const requested = await call("POST", "/students/email-verification/request", {
        token: member.token,
        body: { email: newEmail.toUpperCase() },
      });
      assert.equal(requested.status, 200);
      const code = emailOutbox[emailOutbox.length - 1].text.match(/\b(\d{6})\b/)[1];
      const confirmed = await call("POST", "/students/email-verification/confirm", {
        token: member.token,
        body: { code },
      });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
      const account = await pool.query(
        "SELECT email, email_verified_at FROM accounts WHERE college_id = $1",
        [member.collegeId]
      );
      assert.equal(account.rows[0].email, newEmail);
      assert.ok(account.rows[0].email_verified_at);
      const memberships = await pool.query(
        "SELECT COUNT(*)::int AS count FROM team_members WHERE team_id = $1 AND user_id = (SELECT id FROM accounts WHERE college_id = $2)",
        [created.result.data.registrationId, member.collegeId]
      );
      assert.equal(memberships.rows[0].count, 1);
      const reusedCode = await call("POST", "/students/email-verification/confirm", {
        token: member.token,
        body: { code },
      });
      assert.equal(reusedCode.status, 400);
    });

    await t.test("register, login, balance, and test top-up", async () => {
      const student = await createStudent();
      const me = await call("GET", "/students/me", { token: student.token });
      assert.equal(me.status, 200);
      assert.equal(me.data.balancePaise, 0);
      assert.equal(await topUp(student.token, 12345), 12345);
      const toppedUp = await call("GET", "/students/me", { token: student.token });
      assert.equal(toppedUp.data.balancePaise, 12345);
    });

    await t.test("QR charge is idempotent by payment ID and single-use by QR", async () => {
      const student = await createStudent("QR Payment Student");
      const merchant = await createMerchant();
      await topUp(student.token);
      const qr = await call("GET", "/students/qr", { token: student.token });
      assert.equal(qr.status, 200);
      const payment = {
        token: qr.data.token,
        amountPaise: 4000,
        paymentId: `PAYMENT_${crypto.randomUUID().replaceAll("-", "")}`,
      };
      const firstRace = await call("POST", "/merchants/charge", {
        token: merchant.token,
        body: payment,
      });
      const secondRace = await call("POST", "/merchants/charge", {
        token: merchant.token,
        body: payment,
      });
      const duplicates = await Promise.all([firstRace, secondRace]);
      assert.deepEqual(duplicates.map((result) => result.status), [200, 200]);
      assert.deepEqual(
        duplicates.map((result) => result.data.duplicate).sort(),
        [false, true]
      );
      assert.ok(duplicates.every((result) => result.data.studentBalancePaise === 96000));

      const duplicate = await call("POST", "/merchants/charge", {
        token: merchant.token,
        body: payment,
      });
      assert.equal(duplicate.status, 200, JSON.stringify(duplicate.data));
      assert.equal(duplicate.data.duplicate, true);
      assert.equal(duplicate.data.studentBalancePaise, 96000);

      const changedPayment = await call("POST", "/merchants/charge", {
        token: merchant.token,
        body: { ...payment, amountPaise: 5000 },
      });
      assert.equal(changedPayment.status, 409);

      const reusedQr = await call("POST", "/merchants/charge", {
        token: merchant.token,
        body: { ...payment, paymentId: `PAYMENT_${crypto.randomUUID().replaceAll("-", "")}` },
      });
      assert.equal(reusedQr.status, 409);

      const balance = await call("GET", "/students/me", { token: student.token });
      const merchantBalance = await call("GET", "/merchants/me", { token: merchant.token });
      assert.equal(balance.data.balancePaise, 96000);
      assert.equal(merchantBalance.data.balancePaise, 4000);
      const payments = await pool.query(
        `SELECT COUNT(*)::int AS count FROM qr_payment_requests WHERE payment_id = $1`,
        [payment.paymentId]
      );
      assert.equal(payments.rows[0].count, 1);
    });

    await t.test("freeze blocks wallet use and PIN-protected unfreeze restores it", async () => {
      const student = await createStudent("Freeze Test Student");
      await topUp(student.token, 10000);
      const frozen = await call("POST", "/students/freeze", {
        token: student.token,
        body: { frozen: true, pin: "1234" },
      });
      assert.equal(frozen.status, 200);
      assert.equal(frozen.data.frozen, true);
      assert.equal((await call("POST", "/students/test-topup", {
        token: student.token,
        body: { amountPaise: 1000 },
      })).status, 403);
      assert.equal((await call("GET", "/students/qr", { token: student.token })).status, 403);

      const unfrozen = await call("POST", "/students/freeze", {
        token: student.token,
        body: { frozen: false, pin: "1234" },
      });
      assert.equal(unfrozen.status, 200);
      assert.equal(unfrozen.data.frozen, false);
      assert.equal((await call("GET", "/students/qr", { token: student.token })).status, 200);
    });

    await t.test("all card-level fees, membership purchase, renewal, and expiry fallback", async () => {
      const student = await createStudent("Card Level Student");
      await topUp(student.token);

      const starrowTransfer = await membershipQuote(student.token, "/students/transfer/quote");
      assert.equal(starrowTransfer.status, 403);
      const starrowWithdrawal = await membershipQuote(student.token, "/students/withdrawal/quote");
      assert.equal(starrowWithdrawal.status, 200);
      assert.equal(starrowWithdrawal.data.feePaise, 200);

      const buyFenwick = await call("POST", "/students/card-levels/purchase", {
        token: student.token,
        body: {
          level: "FENWICK",
          period: "semester",
          requestId: `FENWICK_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(buyFenwick.status, 200, JSON.stringify(buyFenwick.data));
      assert.equal(buyFenwick.data.chargedPaise, 9900);
      const fenwickTransfer = await membershipQuote(student.token, "/students/transfer/quote");
      assert.equal(fenwickTransfer.status, 200);
      assert.equal(fenwickTransfer.data.feePaise, 200);
      const fenwickWithdrawal = await membershipQuote(student.token, "/students/withdrawal/quote");
      assert.equal(fenwickWithdrawal.data.feePaise, 200);

      const renewFenwick = await call("POST", "/students/card-levels/purchase", {
        token: student.token,
        body: {
          level: "FENWICK",
          period: "year",
          requestId: `FENWICK_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(renewFenwick.status, 200, JSON.stringify(renewFenwick.data));
      assert.equal(renewFenwick.data.chargedPaise, 19900);
      assert.ok(new Date(renewFenwick.data.expiresAt) > new Date(buyFenwick.data.expiresAt));

      const buyEmberfall = await call("POST", "/students/card-levels/purchase", {
        token: student.token,
        body: {
          level: "EMBERFALL",
          period: "year",
          requestId: `EMBERFALL_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(buyEmberfall.status, 200, JSON.stringify(buyEmberfall.data));
      assert.equal(buyEmberfall.data.chargedPaise, 49900);
      assert.equal(buyEmberfall.data.balancePaise, 20300);
      assert.equal((await membershipQuote(student.token, "/students/transfer/quote")).data.feePaise, 0);
      assert.equal((await membershipQuote(student.token, "/students/withdrawal/quote")).data.feePaise, 0);

      await topUp(student.token);
      const renewEmberfall = await call("POST", "/students/card-levels/purchase", {
        token: student.token,
        body: {
          level: "EMBERFALL",
          period: "year",
          requestId: `EMBERFALL_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(renewEmberfall.status, 200, JSON.stringify(renewEmberfall.data));
      assert.equal(renewEmberfall.data.chargedPaise, 24900);
      assert.ok(new Date(renewEmberfall.data.expiresAt) > new Date(buyEmberfall.data.expiresAt));

      await pool.query(
        `UPDATE accounts
         SET card_level_expires_at = NOW() - INTERVAL '16 days'
         WHERE college_id = $1`,
        [student.collegeId]
      );
      const afterExpiry = await call("GET", "/students/me", { token: student.token });
      assert.equal(afterExpiry.data.cardMembership.level, "FENWICK");
      assert.equal((await membershipQuote(student.token, "/students/transfer/quote")).data.feePaise, 200);

      const ledger = await call("GET", "/students/ledger", { token: student.token });
      assert.equal(
        ledger.data.entries.filter((entry) => entry.entry_type === "card_membership_fee").length,
        4
      );
    });

    await t.test("event registration, duplicate retry, organizer cancellation, and refund", async () => {
      const student = await createStudent("Event Attendee");
      const organizer = await createMerchant("Event Organizer");
      const event = await createEvent(organizer.collegeId, { feePaise: 10000 });
      await topUp(student.token, 20000);
      const listed = await call("GET", "/events", { token: student.token });
      assert.ok(listed.data.events.some((item) => item.id === event.id));

      const requestId = `EVENT_${crypto.randomUUID().replaceAll("-", "")}`;
      const body = { requestId, memberCollegeIds: [] };
      const registered = await call("POST", `/events/${event.id}/register`, {
        token: student.token,
        body,
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.data));
      assert.equal(registered.data.paidPaise, 10000);
      assert.equal(registered.data.balancePaise, 10000);
      const retry = await call("POST", `/events/${event.id}/register`, {
        token: student.token,
        body,
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.data.duplicate, true);

      const forbidden = await call("POST", `/events/${event.id}/cancel`, {
        token: student.token,
      });
      assert.equal(forbidden.status, 403);
      const cancelled = await call("POST", `/events/${event.id}/cancel`, {
        token: organizer.token,
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
      const balance = await call("GET", "/students/me", { token: student.token });
      const organizerBalance = await call("GET", "/merchants/me", { token: organizer.token });
      assert.equal(balance.data.balancePaise, 20000);
      assert.equal(organizerBalance.data.balancePaise, 0);
      const registration = await pool.query(
        "SELECT status, paid_paise FROM event_registrations WHERE id = $1",
        [registered.data.registrationId]
      );
      assert.equal(registration.rows[0].status, "cancelled");
      assert.equal(Number(registration.rows[0].paid_paise), 10000);
    });

    await t.test("cancelling a free-entry registration returns the yearly entry", async () => {
      const student = await createStudent("Free Entry Refund Student");
      const organizer = await createMerchant("Free Entry Refund Organizer");
      await topUp(student.token, 100000);
      await buyEmberfall(student.token);
      const event = await createEvent(organizer.collegeId, {
        title: "Cancelled Free Entry Event",
        feePaise: 12000,
      });
      const registered = await call("POST", `/events/${event.id}/register`, {
        token: student.token,
        body: {
          requestId: `EVENT_${crypto.randomUUID().replaceAll("-", "")}`,
          memberCollegeIds: [],
        },
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.data));
      assert.equal(registered.data.paidPaise, 0);
      assert.equal(registered.data.members[0].entryType, "yearly_free");
      const used = await call("GET", "/students/event-entries", { token: student.token });
      assert.equal(used.data.yearlyFreeEntries, 0);

      const cancelled = await call("POST", `/admin/events/${event.id}/cancel`, {
        adminKey: config.adminKey,
      });
      assert.equal(cancelled.status, 200);
      const returned = await call("GET", "/students/event-entries", { token: student.token });
      assert.equal(returned.data.yearlyFreeEntries, 1);
      const freeEntryLedger = await call("GET", "/students/ledger", { token: student.token });
      const costRows = freeEntryLedger.data.entries.filter((entry) =>
        ["event_free_entry", "event_free_entry_refund"].includes(entry.entry_type)
      );
      assert.deepEqual(costRows.map((entry) => Number(entry.cost_paise)).sort((a, b) => a - b), [-12000, 12000]);
      const balance = await call("GET", "/students/me", { token: student.token });
      assert.equal(balance.data.balancePaise, 50100);
    });

    await t.test("yearly entry is used before top-ups; top-ups carry while Emberfall stays active and expire after lapse", async () => {
      const student = await createStudent("Event Entries Student");
      const organizer = await createMerchant("Entry Event Organizer");
      await topUp(student.token, 200000);
      await buyEmberfall(student.token);

      const initial = await call("GET", "/students/event-entries", { token: student.token });
      assert.equal(initial.data.yearlyFreeEntries, 1);
      assert.equal(initial.data.topUpEntries, 0);

      const firstEvent = await createEvent(organizer.collegeId, {
        title: "Annual Free Entry",
        feePaise: 10000,
      });
      const firstRegistration = await call("POST", `/events/${firstEvent.id}/register`, {
        token: student.token,
        body: {
          requestId: `EVENT_${crypto.randomUUID().replaceAll("-", "")}`,
          memberCollegeIds: [],
        },
      });
      assert.equal(firstRegistration.status, 201, JSON.stringify(firstRegistration.data));
      assert.equal(firstRegistration.data.members[0].entryType, "yearly_free");
      assert.equal(firstRegistration.data.paidPaise, 0);
      assert.equal(
        (await call("GET", "/students/event-entries", { token: student.token })).data.yearlyFreeEntries,
        0
      );

      const topUpRequestId = `ENTRY_${crypto.randomUUID().replaceAll("-", "")}`;
      const purchasedEntry = await call("POST", "/students/event-entries/top-up", {
        token: student.token,
        body: { requestId: topUpRequestId },
      });
      assert.equal(purchasedEntry.status, 200, JSON.stringify(purchasedEntry.data));
      assert.equal(purchasedEntry.data.chargedPaise, 29900);
      assert.equal(purchasedEntry.data.topUpEntries, 1);
      const topUpRetry = await call("POST", "/students/event-entries/top-up", {
        token: student.token,
        body: { requestId: topUpRequestId },
      });
      assert.equal(topUpRetry.data.duplicate, true);
      assert.equal(topUpRetry.data.topUpEntries, 1);

      const secondEvent = await createEvent(organizer.collegeId, {
        title: "Paid Top-up Entry",
        feePaise: 10000,
      });
      const secondRegistration = await call("POST", `/events/${secondEvent.id}/register`, {
        token: student.token,
        body: {
          requestId: `EVENT_${crypto.randomUUID().replaceAll("-", "")}`,
          memberCollegeIds: [],
        },
      });
      assert.equal(secondRegistration.status, 201, JSON.stringify(secondRegistration.data));
      assert.equal(secondRegistration.data.members[0].entryType, "top_up");
      assert.equal(secondRegistration.data.paidPaise, 0);
      assert.equal(
        (await call("GET", "/students/event-entries", { token: student.token })).data.topUpEntries,
        0
      );

      const cancelTopupEvent = await call("POST", `/admin/events/${secondEvent.id}/cancel`, {
        adminKey: config.adminKey,
      });
      assert.equal(cancelTopupEvent.status, 200);
      assert.equal(
        (await call("GET", "/students/event-entries", { token: student.token })).data.topUpEntries,
        1
      );

      await pool.query(
        `UPDATE accounts SET card_level_expires_at = NOW() - INTERVAL '1 day'
         WHERE college_id = $1`,
        [student.collegeId]
      );
      await pool.query(
        `UPDATE membership_purchases SET
           starts_at = NOW() - INTERVAL '1 year',
           expires_at = NOW() - INTERVAL '1 day'
         WHERE account_id = (SELECT id FROM accounts WHERE college_id = $1)
           AND card_level = 'EMBERFALL'`,
        [student.collegeId]
      );
      const renewal = await call("POST", "/students/card-levels/purchase", {
        token: student.token,
        body: {
          level: "EMBERFALL",
          period: "year",
          requestId: `EMBERFALL_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(renewal.status, 200, JSON.stringify(renewal.data));
      assert.equal(renewal.data.chargedPaise, 24900);
      const renewedEntries = await call("GET", "/students/event-entries", { token: student.token });
      assert.equal(renewedEntries.data.yearlyFreeEntries, 1);
      assert.equal(renewedEntries.data.topUpEntries, 1);

      await pool.query(
        `UPDATE accounts SET card_level_expires_at = NOW() - INTERVAL '16 days'
         WHERE college_id = $1`,
        [student.collegeId]
      );
      const lapsedEntries = await call("GET", "/students/event-entries", { token: student.token });
      assert.equal(lapsedEntries.data.cardLevel, "STARROW");
      assert.equal(lapsedEntries.data.yearlyFreeEntries, 0);
      assert.equal(lapsedEntries.data.topUpEntries, 0);
      const expiredCount = await pool.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS quantity
         FROM event_entry_ledger WHERE account_id = (
           SELECT id FROM accounts WHERE college_id = $1
         ) AND entry_type = 'top_up'`,
        [student.collegeId]
      );
      assert.equal(expiredCount.rows[0].quantity, 0);
    });

    await t.test("team event shares round to exact total and Emberfall covers only its members' shares", async () => {
      const leader = await createStudent("Emberfall Team Leader");
      const member = await createStudent("Emberfall Team Member");
      const starrow = await createStudent("Starrow Team Member");
      const organizer = await createMerchant("Team Event Organizer");
      await topUp(leader.token, 200000);
      await topUp(member.token, 200000);
      await topUp(starrow.token, 200000);
      await buyEmberfall(leader.token);
      await buyEmberfall(member.token);
      const event = await createEvent(organizer.collegeId, {
        title: "Three-Person Team Event",
        feePaise: 1000,
        teamSize: 3,
      });
      const registered = await call("POST", `/events/${event.id}/register`, {
        token: leader.token,
        body: {
          requestId: `TEAM_EVENT_${crypto.randomUUID().replaceAll("-", "")}`,
          teamName: "Event Entry Team",
          memberEmails: [member.email, starrow.email],
        },
      });
      assert.equal(registered.status, 201, JSON.stringify(registered.data));
      assert.deepEqual(registered.data.members.map((item) => item.sharePaise), [334, 333, 333]);
      assert.equal(registered.data.members.reduce((sum, item) => sum + item.sharePaise, 0), 1000);
      assert.equal(registered.data.paidPaise, 666);
      assert.equal(registered.data.leaderCoveredPaise, 334);
      assert.equal(registered.data.members[0].coveredPaise, 334);
      assert.equal(registered.data.members[1].coveredPaise, 0);
      assert.equal(registered.data.members[1].paybackDuePaise, 333);
      assert.equal(registered.data.members[2].coveredPaise, 0);
      assert.equal(registered.data.members[2].paybackDuePaise, 333);

      for (const student of [member, starrow]) {
        const accepted = await call("POST", "/students/team-invites/accept", {
          token: student.token,
          body: { token: latestInviteToken(student.email) },
        });
        assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      }
      const teamView = await call("GET", "/students/teams", { token: leader.token });
      const team = teamView.data.teams.find((item) => item.teamId === registered.data.registrationId);
      assert.ok(team);
      assert.equal(team.teamName, "Event Entry Team");
      assert.equal(team.members.find((item) => item.collegeId === member.collegeId).duePaise, 0);
      assert.equal(team.members.find((item) => item.collegeId === starrow.collegeId).duePaise, 333);

      const freeEntryCosts = await pool.query(
        `SELECT account_id, cost_paise, entry_type, amount_paise
         FROM ledger_entries
         WHERE entry_type = 'event_free_entry'
           AND account_id = ANY($1::uuid[])
         ORDER BY cost_paise`,
        [[
          (await pool.query("SELECT id FROM accounts WHERE college_id = $1", [leader.collegeId])).rows[0].id,
          (await pool.query("SELECT id FROM accounts WHERE college_id = $1", [member.collegeId])).rows[0].id,
        ]]
      );
      assert.deepEqual(freeEntryCosts.rows.map((row) => Number(row.cost_paise)), [333, 334]);
      assert.ok(freeEntryCosts.rows.every((row) => Number(row.amount_paise) === 0));
    });

    await t.test("team invitations reject forwarded, reused, expired, and duplicate-event membership claims", async () => {
      await setInviteSettings();
      const leader = await createStudent("Invite Team Leader");
      const member = await createStudent("Invite Team Member");
      const forwarded = await createStudent("Forwarded Invite Account");
      const expiredMember = await createStudent("Expired Invite Member");
      const organizer = await createMerchant("Invite Event Organizer");
      await topUp(leader.token, 30000);

      const first = await registerTeam(leader, organizer, {
        memberEmails: [member.email],
        title: "Invite Security Event One",
      });
      assert.equal(first.result.status, 201, JSON.stringify(first.result.data));
      const inviteLinkResponse = await fetch(
        `${baseUrl}/team-invites/accept?token=${encodeURIComponent(latestInviteToken(member.email))}`
      );
      assert.equal(inviteLinkResponse.status, 200);
      assert.match(await inviteLinkResponse.text(), /Sign in to Campus Wallet/);
      const tooManyMembers = await call("POST", `/events/${first.event.id}/register`, {
        token: leader.token,
        body: {
          requestId: `TOO_MANY_INVITES_${crypto.randomUUID().replaceAll("-", "")}`,
          teamName: "Overfull Team",
          memberEmails: [member.email, forwarded.email],
        },
      });
      assert.equal(tooManyMembers.status, 400);
      const noAccountInvite = await registerTeam(leader, organizer, {
        memberEmails: ["not-registered@example.edu"],
        title: "No Account Enumeration Event",
      });
      assert.equal(noAccountInvite.result.status, 201, JSON.stringify(noAccountInvite.result.data));
      assert.ok(emailOutbox.some((message) => message.to === "not-registered@example.edu"));
      const forwardedResult = await call("POST", "/students/team-invites/accept", {
        token: forwarded.token,
        body: { token: latestInviteToken(member.email) },
      });
      assert.equal(forwardedResult.status, 404);
      assert.equal(forwardedResult.data.error, "Invitation invalid or unavailable");
      const accepted = await acceptTeamInvite(member);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
      const reused = await acceptTeamInvite(member);
      assert.equal(reused.status, 404);

      const second = await registerTeam(leader, organizer, {
        memberEmails: [expiredMember.email],
        title: "Invite Security Event Two",
      });
      assert.equal(second.result.status, 201, JSON.stringify(second.result.data));
      await pool.query(
        "UPDATE team_invites SET expires_at = NOW() - INTERVAL '1 second' WHERE email = $1",
        [expiredMember.email]
      );
      const expired = await acceptTeamInvite(expiredMember);
      assert.equal(expired.status, 404);

      const unverified = await createStudent("Unverified Member", { verifyEmail: false });
      const unverifiedAttempt = await registerTeam(unverified, organizer, {
        memberEmails: [forwarded.email],
        title: "Unverified Leader Event",
      });
      assert.equal(unverifiedAttempt.result.status, 403);
      assert.match(unverifiedAttempt.result.data.error, /Verify your college email/);
    });

    await t.test("a verified student can join only one team per event", async () => {
      await setInviteSettings();
      const firstLeader = await createStudent("First Team Leader");
      const secondLeader = await createStudent("Second Team Leader");
      const member = await createStudent("One Team Only Member");
      const organizer = await createMerchant("One Team Event Organizer");
      await topUp(firstLeader.token, 20000);
      await topUp(secondLeader.token, 20000);
      const event = await createEvent(organizer.collegeId, {
        title: "Single Team Membership Event",
        teamSize: 2,
      });
      const first = await call("POST", `/events/${event.id}/register`, {
        token: firstLeader.token,
        body: {
          requestId: `ONE_TEAM_A_${crypto.randomUUID().replaceAll("-", "")}`,
          teamName: "First Club",
          memberEmails: [member.email],
        },
      });
      assert.equal(first.status, 201, JSON.stringify(first.data));
      assert.equal((await acceptTeamInvite(member)).status, 200);
      const second = await call("POST", `/events/${event.id}/register`, {
        token: secondLeader.token,
        body: {
          requestId: `ONE_TEAM_B_${crypto.randomUUID().replaceAll("-", "")}`,
          teamName: "Second Club",
          memberEmails: [member.email],
        },
      });
      assert.equal(second.status, 201, JSON.stringify(second.data));
      const secondInvite = [...emailOutbox].reverse().find(
        (message) => message.to === member.email && message.subject === "Invitation to Second Club"
      );
      const secondToken = secondInvite.text.match(/[?&]token=([A-Za-z0-9_-]+)/)[1];
      const rejected = await call("POST", "/students/team-invites/accept", {
        token: member.token,
        body: { token: secondToken },
      });
      assert.equal(rejected.status, 409);
      const memberships = await pool.query(
        "SELECT COUNT(*)::int AS count FROM team_members WHERE event_id = $1 AND user_id = (SELECT id FROM accounts WHERE college_id = $2)",
        [event.id, member.collegeId]
      );
      assert.equal(memberships.rows[0].count, 1);
    });

    await t.test("STARROW payback is team-bound, fee-free, capped, idempotent, and refunded on cancellation", async () => {
      await setInviteSettings();
      const leader = await createStudent("Hackathon Leader");
      const member = await createStudent("Starrow Hackathon Member");
      const outsider = await createStudent("Non-member Payback Attempt");
      const organizer = await createMerchant("Hackathon Organizer");
      await topUp(leader.token, 20000);
      await topUp(member.token, 10000);
      const created = await registerTeam(leader, organizer, {
        memberEmails: [member.email],
        teamName: "Campus Hackers",
        title: "Payback Rules Hackathon",
      });
      assert.equal(created.result.status, 201, JSON.stringify(created.result.data));
      const teamId = created.result.data.registrationId;
      assert.equal((await acceptTeamInvite(member)).status, 200);

      const outsiderPayback = await call("POST", `/students/teams/${teamId}/payback`, {
        token: outsider.token,
        body: { requestId: `OUTSIDER_${crypto.randomUUID().replaceAll("-", "")}`, amountPaise: 1, pin: "1234" },
      });
      assert.equal(outsiderPayback.status, 403);

      const overpayment = await call("POST", `/students/teams/${teamId}/payback`, {
        token: member.token,
        body: { requestId: `OVERPAY_${crypto.randomUUID().replaceAll("-", "")}`, amountPaise: 5001, pin: "1234" },
      });
      assert.equal(overpayment.status, 400);

      const otherTransfer = await call("POST", "/students/transfer", {
        token: member.token,
        body: {
          requestId: `STARROW_FRIEND_${crypto.randomUUID().replaceAll("-", "")}`,
          collegeId: leader.collegeId,
          amountPaise: 100,
          pin: "1234",
        },
      });
      assert.equal(otherTransfer.status, 403);

      const reminder = await call("POST", `/students/teams/${teamId}/remind`, {
        token: leader.token,
        body: { memberCollegeId: member.collegeId },
      });
      assert.equal(reminder.status, 200, JSON.stringify(reminder.data));
      assert.equal(emailOutbox[emailOutbox.length - 1].to, member.email);
      assert.match(emailOutbox[emailOutbox.length - 1].subject, /payback reminder/);

      const requestId = `PAYBACK_${crypto.randomUUID().replaceAll("-", "")}`;
      const payback = await call("POST", `/students/teams/${teamId}/payback`, {
        token: member.token,
        body: { requestId, amountPaise: 5000, pin: "1234" },
      });
      assert.equal(payback.status, 200, JSON.stringify(payback.data));
      assert.equal(payback.data.feePaise, 0);
      assert.equal(payback.data.remainingDuePaise, 0);
      const duplicate = await call("POST", `/students/teams/${teamId}/payback`, {
        token: member.token,
        body: { requestId, amountPaise: 5000, pin: "1234" },
      });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.data.duplicate, true);
      const ledger = await pool.query(
        `SELECT entry_type, amount_paise, team_id FROM ledger_entries
         WHERE team_id = $1 AND entry_type = 'team_payback'
         ORDER BY amount_paise`,
        [teamId]
      );
      assert.deepEqual(ledger.rows.map((row) => Number(row.amount_paise)), [-5000, 5000]);
      assert.ok(ledger.rows.every((row) => row.team_id === teamId));
      const feeEntries = await pool.query(
        "SELECT COUNT(*)::int AS count FROM ledger_entries WHERE team_id = $1 AND entry_type = 'transfer_fee'",
        [teamId]
      );
      assert.equal(feeEntries.rows[0].count, 0);

      const secondPayment = await call("POST", `/students/teams/${teamId}/payback`, {
        token: member.token,
        body: { requestId: `PAYBACK_AGAIN_${crypto.randomUUID().replaceAll("-", "")}`, amountPaise: 1, pin: "1234" },
      });
      assert.equal(secondPayment.status, 400);
      const cancelled = await call("POST", `/events/${created.event.id}/cancel`, {
        token: organizer.token,
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
      const cancelledTeamView = await call("GET", "/students/teams", { token: leader.token });
      const cancelledTeam = cancelledTeamView.data.teams.find((team) => team.teamId === teamId);
      assert.ok(cancelledTeam);
      assert.ok(cancelledTeam.invites.every((invite) => invite.pending === false));
      const afterCancellation = await call("POST", `/students/teams/${teamId}/payback`, {
        token: member.token,
        body: { requestId: `AFTER_CANCEL_${crypto.randomUUID().replaceAll("-", "")}`, amountPaise: 1, pin: "1234" },
      });
      assert.equal(afterCancellation.status, 409);
      const refund = await pool.query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS amount
         FROM ledger_entries WHERE account_id = (SELECT id FROM accounts WHERE college_id = $1)
           AND team_id = $2 AND entry_type = 'team_payback_refund'`,
        [member.collegeId, teamId]
      );
      assert.equal(Number(refund.rows[0].amount), 5000);
    });

    await t.test("cancelling a team refunds a Fenwick member's payback fee", async () => {
      const leader = await createStudent("Fenwick Payback Leader");
      const member = await createStudent("Fenwick Payback Member");
      const organizer = await createMerchant("Fenwick Payback Organizer");
      await topUp(leader.token, 30000);
      await topUp(member.token, 30000);
      const membership = await call("POST", "/students/card-levels/purchase", {
        token: member.token,
        body: {
          level: "FENWICK",
          period: "semester",
          requestId: `FENWICK_PAYBACK_${crypto.randomUUID().replaceAll("-", "")}`,
        },
      });
      assert.equal(membership.status, 200, JSON.stringify(membership.data));
      const memberBalanceBefore = (await call("GET", "/students/me", { token: member.token })).data.balancePaise;
      const leaderBalanceBefore = (await call("GET", "/students/me", { token: leader.token })).data.balancePaise;
      const created = await registerTeam(leader, organizer, {
        memberEmails: [member.email],
        title: "Fenwick Payback Refund Event",
      });
      assert.equal(created.result.status, 201, JSON.stringify(created.result.data));
      assert.equal((await acceptTeamInvite(member)).status, 200);
      const payback = await call("POST", `/students/teams/${created.result.data.registrationId}/payback`, {
        token: member.token,
        body: {
          requestId: `FENWICK_PAYBACK_${crypto.randomUUID().replaceAll("-", "")}`,
          amountPaise: 5000,
          pin: "1234",
        },
      });
      assert.equal(payback.status, 200, JSON.stringify(payback.data));
      assert.equal(payback.data.feePaise, 200);
      const cancelled = await call("POST", `/events/${created.event.id}/cancel`, {
        token: organizer.token,
      });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
      const [memberAfter, leaderAfter, feeRefund] = await Promise.all([
        call("GET", "/students/me", { token: member.token }),
        call("GET", "/students/me", { token: leader.token }),
        pool.query(
          `SELECT COALESCE(SUM(amount_paise), 0)::int AS amount
           FROM ledger_entries
           WHERE account_id = (SELECT id FROM accounts WHERE college_id = $1)
             AND team_id = $2 AND entry_type = 'team_payback_fee_refund'`,
          [member.collegeId, created.result.data.registrationId]
        ),
      ]);
      assert.equal(memberAfter.data.balancePaise, memberBalanceBefore);
      assert.equal(leaderAfter.data.balancePaise, leaderBalanceBefore);
      assert.equal(feeRefund.rows[0].amount, 200);
    });

    await t.test("team invite rate limits persist in rolling windows and return retry times", async () => {
      const organizer = await createMerchant("Invite Rate Organizer");
      const currentSettings = await call("GET", "/admin/team-invite-settings", {
        adminKey: config.adminKey,
      });
      assert.equal(currentSettings.status, 200, JSON.stringify(currentSettings.data));
      const updatedSettings = await call("PUT", "/admin/team-invite-settings", {
        adminKey: config.adminKey,
        body: {
          ...currentSettings.data.editable,
          team_invites_per_leader_hour: 12,
        },
      });
      assert.equal(updatedSettings.status, 200, JSON.stringify(updatedSettings.data));
      assert.equal(updatedSettings.data.editable.team_invites_per_leader_hour, 12);

      await setInviteSettings({ team_invites_per_leader_hour: 1 });
      const hourlyLeader = await createStudent("Hourly Invite Leader");
      const hourlyMemberA = await createStudent("Hourly Invite Recipient A");
      const hourlyMemberB = await createStudent("Hourly Invite Recipient B");
      await topUp(hourlyLeader.token, 30000);
      const first = await registerTeam(hourlyLeader, organizer, {
        memberEmails: [hourlyMemberA.email],
        title: "Leader Hourly Invite One",
      });
      assert.equal(first.result.status, 201);
      const limited = await registerTeam(hourlyLeader, organizer, {
        memberEmails: [hourlyMemberB.email],
        title: "Leader Hourly Invite Two",
      });
      assert.equal(limited.result.status, 429);
      assert.equal(limited.result.data.error, "Too many invitations, try again later");
      assert.ok(new Date(limited.result.data.retryAt) > new Date());
      assert.ok(limited.result.data.retryAfterSeconds > 0);

      await setInviteSettings({ team_invites_per_leader_day: 1 });
      const dailyLeader = await createStudent("Daily Invite Leader");
      const dailyMemberA = await createStudent("Daily Invite Recipient A");
      const dailyMemberB = await createStudent("Daily Invite Recipient B");
      await topUp(dailyLeader.token, 30000);
      assert.equal((await registerTeam(dailyLeader, organizer, {
        memberEmails: [dailyMemberA.email],
        title: "Leader Daily Invite One",
      })).result.status, 201);
      const dailyLimited = await registerTeam(dailyLeader, organizer, {
        memberEmails: [dailyMemberB.email],
        title: "Leader Daily Invite Two",
      });
      assert.equal(dailyLimited.result.status, 429);
      assert.ok(dailyLimited.result.data.retryAt);

      await setInviteSettings({ team_invites_per_recipient_leader_hour: 3 });
      const pairLeader = await createStudent("Pair Rate Leader");
      const pairMember = await createStudent("Pair Rate Recipient");
      await topUp(pairLeader.token, 30000);
      const pairTeam = await registerTeam(pairLeader, organizer, {
        memberEmails: [pairMember.email],
        title: "Pair Rate First",
      });
      assert.equal(pairTeam.result.status, 201);
      const originalInviteToken = latestInviteToken(pairMember.email);
      const resendRequest = () => call("POST", `/students/teams/${pairTeam.result.data.registrationId}/invites/resend`, {
        token: pairLeader.token,
        body: {
          requestId: `RESEND_${crypto.randomUUID().replaceAll("-", "")}`,
          email: pairMember.email,
        },
      });
      const tooSoon = await resendRequest();
      assert.equal(tooSoon.status, 429);
      await pool.query(
        `UPDATE team_invite_attempts SET created_at = NOW() - INTERVAL '61 seconds'
         WHERE leader_account_id = (SELECT id FROM accounts WHERE college_id = $1)
           AND recipient_email = $2`,
        [pairLeader.collegeId, pairMember.email]
      );
      const afterCooldown = await resendRequest();
      assert.equal(afterCooldown.status, 200, JSON.stringify(afterCooldown.data));
      const replacedInvite = await call("POST", "/students/team-invites/accept", {
        token: pairMember.token,
        body: { token: originalInviteToken },
      });
      assert.equal(replacedInvite.status, 404);
      await pool.query(
        `UPDATE team_invite_attempts SET created_at = NOW() - INTERVAL '61 seconds'
         WHERE leader_account_id = (SELECT id FROM accounts WHERE college_id = $1)
           AND recipient_email = $2`,
        [pairLeader.collegeId, pairMember.email]
      );
      const secondResend = await resendRequest();
      assert.equal(secondResend.status, 200, JSON.stringify(secondResend.data));
      await pool.query(
        `UPDATE team_invite_attempts SET created_at = NOW() - INTERVAL '61 seconds'
         WHERE leader_account_id = (SELECT id FROM accounts WHERE college_id = $1)
           AND recipient_email = $2`,
        [pairLeader.collegeId, pairMember.email]
      );
      const pairHourlyLimit = await resendRequest();
      assert.equal(pairHourlyLimit.status, 429);

      await setInviteSettings({ team_invites_per_recipient_day: 1 });
      const recipientLeaderA = await createStudent("Recipient Day Leader A");
      const recipientLeaderB = await createStudent("Recipient Day Leader B");
      const dailyRecipient = await createStudent("Recipient Day Target");
      await topUp(recipientLeaderA.token, 20000);
      await topUp(recipientLeaderB.token, 20000);
      assert.equal((await registerTeam(recipientLeaderA, organizer, {
        memberEmails: [dailyRecipient.email],
        title: "Recipient Daily One",
      })).result.status, 201);
      const recipientLimited = await registerTeam(recipientLeaderB, organizer, {
        memberEmails: [dailyRecipient.email],
        title: "Recipient Daily Two",
      });
      assert.equal(recipientLimited.result.status, 429);

      await pool.query("DELETE FROM team_invite_attempts");
      await setInviteSettings({ team_invites_per_ip_hour: 1 });
      const ipLeaderA = await createStudent("IP Hour Leader A");
      const ipLeaderB = await createStudent("IP Hour Leader B");
      const ipMemberA = await createStudent("IP Hour Recipient A");
      const ipMemberB = await createStudent("IP Hour Recipient B");
      await topUp(ipLeaderA.token, 20000);
      await topUp(ipLeaderB.token, 20000);
      assert.equal((await registerTeam(ipLeaderA, organizer, {
        memberEmails: [ipMemberA.email],
        title: "IP Hour One",
      })).result.status, 201);
      const ipLimited = await registerTeam(ipLeaderB, organizer, {
        memberEmails: [ipMemberB.email],
        title: "IP Hour Two",
      });
      assert.equal(ipLimited.result.status, 429);

      await pool.query("DELETE FROM team_invite_attempts");
      await setInviteSettings({ team_invites_per_leader_hour: 1 });
      const rollingLeader = await createStudent("Rolling Window Leader");
      const rollingMember = await createStudent("Rolling Window Recipient");
      await topUp(rollingLeader.token, 20000);
      await pool.query(
        `INSERT INTO team_invite_attempts
           (id, request_id, leader_account_id, recipient_email, client_ip, created_at)
         VALUES ($1, $2, (SELECT id FROM accounts WHERE college_id = $3), $4, 'old-test-ip',
                 NOW() - INTERVAL '61 minutes')`,
        [crypto.randomUUID(), `OLD_${crypto.randomUUID().replaceAll("-", "")}`, rollingLeader.collegeId, `${nextCollegeId("OLD").toLowerCase()}@example.edu`]
      );
      const afterWindow = await registerTeam(rollingLeader, organizer, {
        memberEmails: [rollingMember.email],
        title: "Rolling Window Reset",
      });
      assert.equal(afterWindow.result.status, 201, JSON.stringify(afterWindow.result.data));

      await setInviteSettings();
    });

    await t.test("simultaneous QR payments cannot overspend one student's balance", async () => {
      const student = await createStudent("Concurrent Payment Student");
      const merchantA = await createMerchant("Concurrent Merchant A");
      const merchantB = await createMerchant("Concurrent Merchant B");
      await topUp(student.token, 5000);
      const qrA = await call("GET", "/students/qr", { token: student.token });
      const qrB = await call("GET", "/students/qr", { token: student.token });
      assert.equal(qrA.status, 200);
      assert.equal(qrB.status, 200);

      const results = await Promise.all([
        call("POST", "/merchants/charge", {
          token: merchantA.token,
          body: {
            token: qrA.data.token,
            amountPaise: 4000,
            paymentId: `CONCURRENT_${crypto.randomUUID().replaceAll("-", "")}`,
          },
        }),
        call("POST", "/merchants/charge", {
          token: merchantB.token,
          body: {
            token: qrB.data.token,
            amountPaise: 4000,
            paymentId: `CONCURRENT_${crypto.randomUUID().replaceAll("-", "")}`,
          },
        }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
      const balance = await call("GET", "/students/me", { token: student.token });
      assert.equal(balance.data.balancePaise, 1000);
      const totalSales = await pool.query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
         FROM ledger_entries
         WHERE account_id = ANY($1::uuid[]) AND entry_type = 'qr_sale'`,
        [
          [
            (await pool.query("SELECT id FROM accounts WHERE college_id = $1", [merchantA.collegeId])).rows[0].id,
            (await pool.query("SELECT id FROM accounts WHERE college_id = $1", [merchantB.collegeId])).rows[0].id,
          ],
        ]
      );
      assert.equal(Number(totalSales.rows[0].total), 4000);
    });

    await t.test("ledger rows reject mutation", async () => {
      const student = await createStudent("Append Only Test Student");
      await topUp(student.token, 1000);
      const account = await pool.query("SELECT id FROM accounts WHERE college_id = $1", [student.collegeId]);
      await assert.rejects(
        pool.query(
          "UPDATE ledger_entries SET amount_paise = 0 WHERE account_id = $1",
          [account.rows[0].id]
        ),
        /ledger_entries is append-only/
      );
    });
  }
);
