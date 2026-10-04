require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { loadConfig } = require("./config");
const { createPool } = require("./db");
const { createApp } = require("./app");

async function start() {
  const config = loadConfig();
  if (!config.testMode) {
    console.warn("TEST_MODE is false, but real payment rails are still not implemented.");
  }
  if (config.jwtSecret === "change-me-local-only" || config.adminKey === "change-me-admin-key") {
    console.warn("Using placeholder secrets from .env.example — local test only.");
  }

  const pool = createPool(config.databaseUrl);
  try {
    const schema = await fs.readFile(path.join(__dirname, "..", "schema.sql"), "utf8");
    await pool.query(schema);
  } catch (error) {
    console.error("Failed to initialize Campus Wallet database schema.", error);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  const app = createApp({ pool, config });
  const server = app.listen(config.port, () => {
    console.log(`Campus Wallet TEST API on http://localhost:${config.port}`);
    console.log("Admin UI: http://localhost:" + config.port + "/admin/");
  });

  async function shutdown() {
    server.close();
    await pool.end();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Failed to start Campus Wallet API.", error);
  process.exitCode = 1;
});
