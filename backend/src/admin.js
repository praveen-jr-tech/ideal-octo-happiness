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

  function validatePhotoData(value) {
    if (!value) return null;
    if (
      typeof value !== "string" ||
      value.length > 350_000 ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) {
      throw new HttpError(400, "Profile photo must be a small JPEG, PNG, or WebP image");
    }
    return value;
  }

  app.post(
    "/admin/accounts",
    asyncHandler(async (req, res) => {
      const { collegeId, name, pin } = req.body || {};
      const role = String(req.body?.role || "").toLowerCase();
      assertCollegeId(collegeId);
      assertPinFormat(pin);
      if (role !== "student" && role !== "merchant") throw new HttpError(400, "Choose Student or Canteen");
      const trimmedName = String(name || "").trim();
      if (trimmedName.length < 2 || trimmedName.length > 80) throw new HttpError(400, "Name must be 2-80 characters");
      const photoData = validatePhotoData(req.body?.photoData);
      const id = crypto.randomUUID();
      try {
        await pool.query(
          `INSERT INTO accounts (id, role, college_id, name, pin_hash, photo_data, frozen)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
          [id, role, collegeId.toUpperCase(), trimmedName, hashPin(pin), photoData]
        );
      } catch (err) {
        if (err.code === "23505") throw new HttpError(409, "ID already exists");
        throw err;
      }
      res.status(201).json({ ok: true, account: { id, role, collegeId: collegeId.toUpperCase(), name: trimmedName, photoData } });
    })
  );

  app.patch(
    "/admin/accounts",
    asyncHandler(async (req, res) => {
      const { originalCollegeId, collegeId, name, pin } = req.body || {};
      assertCollegeId(originalCollegeId);
      assertCollegeId(collegeId);
      const role = String(req.body?.role || "").toLowerCase();
      if (role !== "student" && role !== "merchant") throw new HttpError(400, "Choose Student or Canteen");
      const trimmedName = String(name || "").trim();
      if (trimmedName.length < 2 || trimmedName.length > 80) throw new HttpError(400, "Name must be 2-80 characters");
      if (pin) assertPinFormat(pin);
      const { rows: found } = await pool.query("SELECT * FROM accounts WHERE college_id = $1", [originalCollegeId.toUpperCase()]);
      if (!found[0]) throw new HttpError(404, "Account not found");
      if (found[0].role !== role) {
        const { rows: usage } = await pool.query(
          `SELECT EXISTS (SELECT 1 FROM ledger_entries WHERE account_id = $1)
             OR EXISTS (SELECT 1 FROM qr_tokens WHERE student_id = $1) AS has_activity`,
          [found[0].id]
        );
        if (usage[0].has_activity) throw new HttpError(409, "Account type cannot change after wallet activity");
      }
      const photoData = req.body?.photoData === undefined
        ? found[0].photo_data
        : validatePhotoData(req.body.photoData);
      try {
        const { rows } = await pool.query(
          `UPDATE accounts SET role = $1, college_id = $2, name = $3,
             pin_hash = COALESCE($4, pin_hash), photo_data = $5
           WHERE id = $6
           RETURNING id, role, college_id, name, photo_data`,
          [role, collegeId.toUpperCase(), trimmedName, pin ? hashPin(pin) : null, photoData, found[0].id]
        );
        const account = rows[0];
        res.json({ ok: true, account: { id: account.id, role: account.role, collegeId: account.college_id, name: account.name, photoData: account.photo_data } });
      } catch (err) {
        if (err.code === "23505") throw new HttpError(409, "ID already exists");
        throw err;
      }
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
        `SELECT a.id, a.role, a.college_id, a.name, a.photo_data, a.frozen, a.created_at,
                a.card_level, a.card_level_expires_at,
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
          photoData: r.photo_data || null,
          frozen: r.frozen,
          cardLevel: r.role === "student" ? r.card_level : null,
          cardLevelExpiresAt: r.card_level_expires_at,
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
        `SELECT l.id, l.amount_paise, l.cost_paise, l.entry_type, l.note, l.created_at,
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
