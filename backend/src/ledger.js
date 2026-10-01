const { HttpError } = require("./db");

async function getBalancePaise(client, accountId) {
  const { rows } = await client.query(
    "SELECT COALESCE(SUM(amount_paise), 0)::bigint AS balance FROM ledger_entries WHERE account_id = $1",
    [accountId]
  );
  return Number(rows[0].balance);
}

async function insertEntry(client, { id, accountId, amountPaise, entryType, relatedAccountId, note }) {
  await client.query(
    `INSERT INTO ledger_entries (id, account_id, amount_paise, entry_type, related_account_id, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, accountId, amountPaise, entryType, relatedAccountId || null, note || null]
  );
}

async function payMerchant(client, { student, merchant, amountPaise, crypto }) {
  if (student.frozen) {
    throw new HttpError(403, "Student account is frozen");
  }
  if (amountPaise <= 0 || !Number.isInteger(amountPaise)) {
    throw new HttpError(400, "amountPaise must be a positive integer");
  }
  const balance = await getBalancePaise(client, student.id);
  if (balance < amountPaise) {
    throw new HttpError(400, "Insufficient test balance");
  }
  const debitId = crypto.randomUUID();
  const creditId = crypto.randomUUID();
  await insertEntry(client, {
    id: debitId,
    accountId: student.id,
    amountPaise: -amountPaise,
    entryType: "qr_payment",
    relatedAccountId: merchant.id,
    note: `Pay ${merchant.college_id}`,
  });
  await insertEntry(client, {
    id: creditId,
    accountId: merchant.id,
    amountPaise,
    entryType: "qr_sale",
    relatedAccountId: student.id,
    note: `From ${student.college_id}`,
  });
  return { debitId, creditId, studentBalancePaise: balance - amountPaise };
}

module.exports = { getBalancePaise, insertEntry, payMerchant };
