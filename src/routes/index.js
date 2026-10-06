const express = require("express");
const router = express.Router();

const authRoutes = require("./auth.routes");
const adminRoutes = require("./admin.routes");
const headDriverRoutes = require("./head_driver.routes");
const driverRoutes = require("./driver.routes");
const notificationRoutes = require("./notification.routes");
const userRoutes = require("./user.routes");
const tripRoutes = require("./trip.routes");

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/head-driver", headDriverRoutes); // approval queue + reassignment
router.use("/driver", driverRoutes); // assigned trips, accept/decline, departure/return
router.use("/notifications", notificationRoutes); // every role
router.use("/", userRoutes); // GET /me, PATCH /me/avatar
router.use("/trips", tripRoutes); // POST /trips, GET /trips/mine

module.exports = router;