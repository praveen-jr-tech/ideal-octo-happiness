const crypto = require("crypto");

async function appendEventEntry(client, {
  accountId,
  referenceKey,
  entryType,
  action,
  quantity,
  costPaise = 0,
  membershipRequestId = null,
  registrationId = null,
}) {
  await client.query(
    `INSERT INTO event_entry_ledger
       (id, reference_key, account_id, entry_type, action, quantity, cost_paise,
        membership_request_id, registration_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      crypto.randomUUID(),
      referenceKey,
      accountId,
      entryType,
      action,
      quantity,
      costPaise,
      membershipRequestId,
      registrationId,
    ]
  );
}

function splitTeamFee(totalFeePaise, teamSize) {
  if (!Number.isSafeInteger(totalFeePaise) || totalFeePaise <= 0) {
    throw new TypeError("totalFeePaise must be a positive safe integer");
  }
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 4) {
    throw new TypeError("teamSize must be an integer between 1 and 4");
  }
  const baseShare = Math.floor(totalFeePaise / teamSize);
  const remainingPaise = totalFeePaise % teamSize;
  return Array.from({ length: teamSize }, (_, index) =>
    baseShare + (index < remainingPaise ? 1 : 0)
  );
}

async function availableEventEntries(client, accountId, membership) {
  if (membership.level !== "EMBERFALL") {
    return { yearlyFreeEntries: 0, topUpEntries: 0 };
  }

  await client.query(
    `INSERT INTO event_entry_ledger
       (id, reference_key, account_id, entry_type, action, quantity, membership_request_id)
     SELECT gen_random_uuid(), 'emberfall-yearly-free:' || mp.request_id,
            mp.account_id, 'yearly_free', 'grant', 1, mp.request_id
     FROM membership_purchases mp
     WHERE mp.account_id = $1 AND mp.card_level = 'EMBERFALL'
       AND mp.starts_at <= NOW() AND mp.expires_at > NOW()
       AND NOT EXISTS (
         SELECT 1 FROM event_entry_ledger eel
         WHERE eel.reference_key = 'emberfall-yearly-free:' || mp.request_id
       )
     ON CONFLICT (reference_key) DO NOTHING`,
    [accountId]
  );

  const { rows } = await client.query(
    `WITH active_year AS (
       SELECT request_id
       FROM membership_purchases
       WHERE account_id = $1 AND card_level = 'EMBERFALL'
         AND starts_at <= NOW() AND expires_at > NOW()
       ORDER BY starts_at DESC
       LIMIT 1
     )
     SELECT
       (SELECT request_id FROM active_year LIMIT 1) AS membership_request_id,
       COALESCE(SUM(quantity) FILTER (
         WHERE entry_type = 'yearly_free'
           AND membership_request_id IN (SELECT request_id FROM active_year)
       ), 0)::int AS yearly_free_entries,
       COALESCE(SUM(quantity) FILTER (WHERE entry_type = 'top_up'), 0)::int
         AS top_up_entries
     FROM event_entry_ledger
     WHERE account_id = $1`,
    [accountId]
  );
  return {
    yearlyFreeEntries: Math.max(0, rows[0].yearly_free_entries),
    topUpEntries: Math.max(0, rows[0].top_up_entries),
    membershipRequestId: rows[0].membership_request_id || null,
  };
}

async function expireLapsedTopupEntries(client, account, membership) {
  if (
    account.card_level !== "EMBERFALL" ||
    membership.level === "EMBERFALL" ||
    !account.card_level_expires_at
  ) {
    return;
  }

  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS remaining
     FROM event_entry_ledger
     WHERE account_id = $1 AND entry_type = 'top_up'`,
    [account.id]
  );
  const remaining = Math.max(0, rows[0].remaining);
  if (remaining === 0) return;

  const lapseKey = new Date(account.card_level_expires_at).toISOString();
  await appendEventEntry(client, {
    accountId: account.id,
    referenceKey: `expire-topups:${account.id}:${lapseKey}`,
    entryType: "top_up",
    action: "expire",
    quantity: -remaining,
  });
}

async function grantYearlyFreeEntry(client, {
  accountId,
  membershipRequestId,
}) {
  await appendEventEntry(client, {
    accountId,
    referenceKey: `emberfall-yearly-free:${membershipRequestId}`,
    entryType: "yearly_free",
    action: "grant",
    quantity: 1,
    membershipRequestId,
  });
}

module.exports = {
  appendEventEntry,
  availableEventEntries,
  expireLapsedTopupEntries,
  grantYearlyFreeEntry,
  splitTeamFee,
};
