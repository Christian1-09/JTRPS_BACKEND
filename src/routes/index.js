const express = require("express");
const router = express.Router();

const authRoutes = require("./auth.routes");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/roleCheck");

router.use("/auth", authRoutes);

// Returns the currently logged-in user's identity/role.
// Any authenticated user (regardless of role) can call this.
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

// --- Example role-protected endpoints ---
// Replace these with real feature routes (trips, vehicles, bookings, etc.)
// as you build them out. This just demonstrates the pattern.

router.get("/admin/dashboard", authenticate, requireRole("ADMIN"), (req, res) => {
  res.json({ message: "Welcome, admin." });
});

router.get(
  "/head-driver/dashboard",
  authenticate,
  requireRole("ADMIN", "HEAD_DRIVER"),
  (req, res) => {
    res.json({ message: "Welcome, head driver." });
  }
);

router.get(
  "/driver/dashboard",
  authenticate,
  requireRole("ADMIN", "HEAD_DRIVER", "DRIVER"),
  (req, res) => {
    res.json({ message: "Welcome, driver." });
  }
);

router.get(
  "/instructor/dashboard",
  authenticate,
  requireRole("ADMIN", "INSTRUCTOR"),
  (req, res) => {
    res.json({ message: "Welcome, instructor." });
  }
);

module.exports = router;
