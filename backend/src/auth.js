const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { HttpError } = require("./db");

const PIN_ROUNDS = 10;

function hashPin(pin) {
  return bcrypt.hashSync(String(pin), PIN_ROUNDS);
}

function verifyPin(pin, pinHash) {
  return bcrypt.compareSync(String(pin), pinHash);
}

function assertPinFormat(pin) {
  if (!/^\d{4,8}$/.test(String(pin || ""))) {
    throw new HttpError(400, "PIN must be 4 to 8 digits");
  }
}

function assertCollegeId(collegeId) {
  if (!/^[A-Za-z0-9]{3,32}$/.test(String(collegeId || ""))) {
    throw new HttpError(400, "collegeId must be 3-32 letters or digits");
  }
}

function signToken(config, account) {
  return jwt.sign(
    { sub: account.id, role: account.role, collegeId: account.college_id },
    config.jwtSecret,
    { expiresIn: "12h" }
  );
}

function authRequired(config, role) {
  return (req, _res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      return next(new HttpError(401, "Missing bearer token"));
    }
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      if (role && payload.role !== role) {
        return next(new HttpError(403, "Wrong account role"));
      }
      req.auth = payload;
      next();
    } catch (_err) {
      next(new HttpError(401, "Invalid or expired token"));
    }
  };
}

function adminRequired(config) {
  return (req, _res, next) => {
    const authorization = req.headers.authorization || "";
    if (authorization.startsWith("Bearer ")) {
      try {
        const payload = jwt.verify(authorization.slice(7), config.jwtSecret);
        if (payload.role !== "admin") return next(new HttpError(403, "Wrong account role"));
        req.auth = payload;
        return next();
      } catch (_err) {
        return next(new HttpError(401, "Invalid or expired token"));
      }
    }
    const key = req.headers["x-admin-key"];
    if (!key || key !== config.adminKey) {
      return next(new HttpError(401, "Invalid admin key"));
    }
    next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  hashPin,
  verifyPin,
  assertPinFormat,
  assertCollegeId,
  signToken,
  authRequired,
  adminRequired,
  asyncHandler,
};
