const path = require("path");
const express = require("express");
const cors = require("cors");
const { HttpError } = require("./db");
const { adminRequired } = require("./auth");
const { mountStudentRoutes } = require("./students");
const { mountMerchantRoutes } = require("./merchants");
const { mountAdminRoutes } = require("./admin");

function createApp({ pool, config }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));
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
  mountMerchantRoutes(app, { pool, config });

  app.use("/admin", adminRequired(config));
  mountAdminRoutes(app, { pool, config });

  app.use((_req, _res, next) => next(new HttpError(404, "Not found")));

  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    const message = status === 500 ? "Server error" : err.message;
    if (status === 500) {
      console.error(err);
    }
    res.status(status).json({ error: message, testMode: config.testMode });
  });

  return app;
}

module.exports = { createApp };
