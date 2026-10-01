const { Pool } = require("pg");

function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { createPool, HttpError };
