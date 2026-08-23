const { verifyAccessToken } = require("../utils/jwt");

/**
 * Reads "Authorization: Bearer <token>", verifies it, and attaches
 * the decoded payload ({ sub, role, email }) to req.user.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing or invalid Authorization header" });
  }

  const token = header.split(" ")[1];

  try {
    const payload = verifyAccessToken(token);
    req.user = payload; // { sub, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = authenticate;
