const assert = require("node:assert/strict");
const test = require("node:test");
const { loadConfig, parseEmailDomains } = require("../src/config");
const { normalizeCollegeEmail } = require("../src/email_verification");

test("college email domains match exactly, case-insensitively, without implicit subdomains", () => {
  const domains = parseEmailDomains("YourCollege.edu.in,EXAMPLE.EDU", false);
  assert.deepEqual(domains, ["yourcollege.edu.in", "example.edu"]);
  assert.equal(
    normalizeCollegeEmail("Student.Name@YOURCOLLEGE.EDU.IN", domains),
    "student.name@yourcollege.edu.in"
  );
  assert.throws(
    () => normalizeCollegeEmail("student@yourcollege.edu.in.evil.com", domains),
    /allowed college domain/
  );
  assert.throws(
    () => normalizeCollegeEmail("student@evilyourcollege.edu.in", domains),
    /allowed college domain/
  );
  assert.throws(
    () => normalizeCollegeEmail("student@sub.yourcollege.edu.in", domains),
    /allowed college domain/
  );
});

test("empty email-domain config uses example.edu only in test mode", () => {
  assert.deepEqual(parseEmailDomains("", true), ["example.edu"]);
  assert.throws(() => parseEmailDomains("", false), /ALLOWED_EMAIL_DOMAINS/);
  const base = {
    DATABASE_URL: "postgresql://localhost/campus_wallet",
    JWT_SECRET: "test-secret",
    ADMIN_KEY: "test-admin",
  };
  assert.deepEqual(
    loadConfig({ ...base, TEST_MODE: "true", ALLOWED_EMAIL_DOMAINS: "" }).allowedEmailDomains,
    ["example.edu"]
  );
  assert.throws(
    () => loadConfig({ ...base, TEST_MODE: "false", ALLOWED_EMAIL_DOMAINS: "" }),
    /ALLOWED_EMAIL_DOMAINS/
  );
});

test("invalid or empty domain tokens are not accepted as a wildcard", () => {
  assert.deepEqual(parseEmailDomains(" , ", true), ["example.edu"]);
  assert.throws(() => parseEmailDomains("*.example.edu", true), /invalid domain/);
});
