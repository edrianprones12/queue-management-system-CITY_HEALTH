const jwt = require("jsonwebtoken");
const env = require("../config/env");
const { validateAuthSession } = require("../services/presenceService");

async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = typeof authHeader === "string" && authHeader.match(/^Bearer ([^\s]+)$/i)?.[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  let user;
  try {
    user = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  } catch (_error) {
    return res.status(403).json({ success: false, message: "Invalid or expired token" });
  }
  try {
    req.authSession = await validateAuthSession(user);
  } catch (error) {
    return res.status(error.statusCode || 503).json({ success: false, message: error.message });
  }
  req.user = user;
  return next();
}

function authorizeRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }
    next();
  };
}

module.exports = { authenticateToken, authorizeRole };
