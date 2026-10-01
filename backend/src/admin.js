const crypto = require("crypto");
const { assertCollegeId, assertPinFormat, hashPin, asyncHandler } = require("./auth");
const { HttpError } = require("./db");

function mountAdminRoutes(app, { pool }) {
  app.post(
    "/admin/create-merchant",
    asyncHandler(async (req, res) => {
      const { collegeId, name, pin } = req.body || {};
      assertCollegeId(collegeId);
      assertPinFormat(pin);
      const trimmedName = String(name || "").trim();
      if (trimmedName.length < 2) throw new HttpError(400, "name is required");
      const id = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen)
           VALUES ($1, 'merchant', $2, $3, $4, FALSE)`,
          [id, collegeId.toUpperCase(), trimmedName, hashPin(pin)]
        );
      } catch (err) {
        if (err.code === "23505") {
          throw new HttpError(409, "Merchant collegeId already exists");
        }
        throw err;
      }
      res.status(201).json({
        ok: true,
        merchant: { id, collegeId: collegeId.toUpperCase(), name: trimmedName, testMode: true },
      });
    })
  );

  app.get(
    "/admin/summary",
    asyncHandler(async (req, res) => {
      const students = await pool.query("SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'student'");
      const merchants = await pool.query("SELECT COUNT(*)::int AS n FROM accounts WHERE role = 'merchant'");
      const frozen = await pool.query("SELECT COUNT(*)::int AS n FROM accounts WHERE frozen = TRUE");
      const volume = await pool.query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS n
         FROM ledger_entries WHERE entry_type = 'qr_sale'`
      );
      const topups = await pool.query(
        `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS n
         FROM ledger_entries WHERE entry_type = 'test_topup'`
      );
      res.json({
        testMode: true,
        students: students.rows[0].n,
        merchants: merchants.rows[0].n,
        frozen: frozen.rows[0].n,
        qrSalesPaise: Number(volume.rows[0].n),
        testTopupsPaise: Number(topups.rows[0].n),
      });
    })
  );

  app.get(
    "/admin/accounts",
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT a.id, a.role, a.college_id, a.name, a.frozen, a.created_at,
                COALESCE(SUM(l.amount_paise), 0)::bigint AS balance_paise
         FROM accounts a
         LEFT JOIN ledger_entries l ON l.account_id = a.id
         GROUP BY a.id
         ORDER BY a.role, a.college_id`
      );
      res.json({
        accounts: rows.map((r) => ({
          id: r.id,
          role: r.role,
          collegeId: r.college_id,
          name: r.name,
          frozen: r.frozen,
          balancePaise: Number(r.balance_paise),
          createdAt: r.created_at,
        })),
      });
    })
  );

  app.get(
    "/admin/ledger",
    asyncHandler(async (req, res) => {
      const { rows } = await pool.query(
        `SELECT l.id, l.amount_paise, l.entry_type, l.note, l.created_at,
                a.college_id, a.role
         FROM ledger_entries l
         JOIN accounts a ON a.id = l.account_id
         ORDER BY l.created_at DESC
         LIMIT 200`
      );
      res.json({ entries: rows });
    })
  );

  app.post(
    "/admin/freeze",
    asyncHandler(async (req, res) => {
      const { collegeId, frozen } = req.body || {};
      assertCollegeId(collegeId);
      const { rows } = await pool.query(
        "UPDATE accounts SET frozen = $1 WHERE college_id = $2 RETURNING college_id, frozen, role, name",
        [Boolean(frozen), collegeId.toUpperCase()]
      );
      if (!rows[0]) throw new HttpError(404, "Account not found");
      res.json({ ok: true, account: rows[0] });
    })
  );
}

module.exports = { mountAdminRoutes };
