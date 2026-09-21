const express = require("express");
const router = express.Router();

const authRoutes = require("./auth.routes");
const adminRoutes = require("./admin.routes");
const headDriverRoutes = require("./head_driver.routes");
const userRoutes = require("./user.routes");
const tripRoutes = require("./trip.routes");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/roleCheck");

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/head-driver", headDriverRoutes); // approval queue + reassignment
router.use("/", userRoutes); // GET /me, PATCH /me/avatar
router.use("/trips", tripRoutes); // POST /trips, GET /trips/mine

// --- Example role-protected endpoints ---
router.get("/admin/dashboard", authenticate, requireRole("ADMIN"), (req, res) => {
  res.json({ message: "Welcome, admin." });
});

router.get(
  "/driver/dashboard",
  authenticate,
  requireRole("ADMIN", "HEAD_DRIVER", "DRIVER"),
  (req, res) => {
    res.json({ message: "Welcome, driver." });
  }
);

module.exports = router;