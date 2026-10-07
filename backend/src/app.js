const path = require("path");
const express = require("express");
const cors = require("cors");
const { HttpError } = require("./db");
const { adminRequired } = require("./auth");
const { mountStudentRoutes } = require("./students");
const { mountMerchantRoutes } = require("./merchants");
const { mountAdminRoutes } = require("./admin");
const {
  mountAdminCardLevelRoutes,
  mountStudentCardLevelRoutes,
} = require("./card_levels");
const { mountAdminEventRoutes, mountStudentEventRoutes } = require("./events");
const { mountEmailVerificationRoutes } = require("./email_verification");
const { mountStudentTeamRoutes } = require("./team_paybacks");

function createApp({ pool, config }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "512kb" }));
  app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      testMode: config.testMode,
      realPayments: false,
      service: "campus-wallet",
      version: "1-test",
    });
  });

  mountStudentRoutes(app, { pool, config });
  mountEmailVerificationRoutes(app, { pool, config });
  mountStudentCardLevelRoutes(app, { pool, config });
  mountStudentEventRoutes(app, { pool, config });
  mountStudentTeamRoutes(app, { pool, config });
  mountMerchantRoutes(app, { pool, config });

  app.use("/admin", adminRequired(config));
  mountAdminRoutes(app, { pool, config });
  mountAdminCardLevelRoutes(app, { pool });
  mountAdminEventRoutes(app, { pool, config });

  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    const message = status === 500 ? "Server error" : err.message;
    if (status === 500) {
      console.error(err);
    }
    res.status(status).json({
      error: message,
      ...(err.retryAt ? { retryAt: err.retryAt, retryAfterSeconds: err.retryAfterSeconds } : {}),
      testMode: config.testMode,
    });
  });

  return app;
}

module.exports = { createApp };
