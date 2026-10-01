require("dotenv").config();
const { loadConfig } = require("./config");
const { createPool } = require("./db");
const { createApp } = require("./app");

const config = loadConfig();
if (!config.testMode) {
  console.warn("TEST_MODE is false, but real payment rails are still not implemented.");
}
if (config.jwtSecret === "change-me-local-only" || config.adminKey === "change-me-admin-key") {
  console.warn("Using placeholder secrets from .env.example — local test only.");
}

const pool = createPool(config.databaseUrl);
const app = createApp({ pool, config });

const server = app.listen(config.port, () => {
  console.log(`Campus Wallet TEST API on http://localhost:${config.port}`);
  console.log("Admin UI: http://localhost:" + config.port + "/admin/");
});

async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
