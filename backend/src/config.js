function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function loadConfig() {
  const testMode = String(process.env.TEST_MODE || "true").toLowerCase() === "true";
  return {
    port: Number(process.env.PORT || 3000),
    databaseUrl: required("DATABASE_URL"),
    jwtSecret: required("JWT_SECRET"),
    adminKey: required("ADMIN_KEY"),
    testMode,
    qrTtlSeconds: Number(process.env.QR_TTL_SECONDS || 45),
  };
}

module.exports = { loadConfig };
