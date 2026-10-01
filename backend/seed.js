require("dotenv").config();
const crypto = require("crypto");
const { loadConfig } = require("./src/config");
const { createPool } = require("./src/db");
const { hashPin } = require("./src/auth");

const DEMO = [
  { role: "student", collegeId: "STU1001", name: "Alex Test", pin: "1234" },
  { role: "student", collegeId: "STU1002", name: "Jordan Demo", pin: "1234" },
  { role: "merchant", collegeId: "CANTEEN1", name: "Main Canteen", pin: "1234" },
];

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    for (const row of DEMO) {
      const existing = await pool.query("SELECT id FROM accounts WHERE college_id = $1", [row.collegeId]);
      if (existing.rows[0]) {
        console.log("exists", row.collegeId);
        continue;
      }
      await pool.query(
        `INSERT INTO accounts (id, role, college_id, name, pin_hash, frozen)
         VALUES ($1, $2, $3, $4, $5, FALSE)`,
        [crypto.randomUUID(), row.role, row.collegeId, row.name, hashPin(row.pin)]
      );
      console.log("created", row.collegeId, "(" + row.role + ")");
    }
    console.log("Seed complete. Fictional accounts only. PIN 1234 is for local test.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
