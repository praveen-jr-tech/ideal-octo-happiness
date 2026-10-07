const { Pool } = require("pg");

function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
}

class HttpError extends Error {
  constructor(status, message, { retryAt, retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.retryAt = retryAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

module.exports = { createPool, HttpError };
