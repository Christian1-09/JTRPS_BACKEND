/**
 * Usage: router.get("/admin-only", authenticate, requireRole("ADMIN"), handler)
 * Or multiple roles: requireRole("ADMIN", "HEAD_DRIVER")
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient permissions" });
    }

    next();
  };
}

module.exports = requireRole;
