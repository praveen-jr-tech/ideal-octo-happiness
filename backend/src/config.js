function required(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}

function parseEmailDomains(value, testMode) {
  const domains = String(value || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(domain))) {
    throw new Error("ALLOWED_EMAIL_DOMAINS contains an invalid domain");
  }
  if (domains.length) return [...new Set(domains)];
  if (testMode) return ["example.edu"];
  throw new Error("ALLOWED_EMAIL_DOMAINS must contain at least one college domain outside TEST_MODE");
}

function loadConfig(env = process.env) {
  const testMode = String(env.TEST_MODE || "true").toLowerCase() === "true";
  return {
    port: Number(env.PORT || 3000),
    publicAppUrl: String(env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
    databaseUrl: required("DATABASE_URL", env),
    jwtSecret: required("JWT_SECRET", env),
    adminKey: required("ADMIN_KEY", env),
    testMode,
    qrTtlSeconds: Number(env.QR_TTL_SECONDS || 45),
    allowedEmailDomains: parseEmailDomains(env.ALLOWED_EMAIL_DOMAINS, testMode),
    emailLogger: (message) => console.log(`[TEST EMAIL]\nTo: ${message.to}\nSubject: ${message.subject}\n${message.text}`),
  };
}

module.exports = { loadConfig, parseEmailDomains };
