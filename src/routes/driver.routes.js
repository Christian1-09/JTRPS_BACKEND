const express = require("express");
const router = express.Router();
const driverController = require("../controllers/driver.controller");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/roleCheck");

// Drivers AND the Head Driver — he drives too, with the same workflow.
router.use(authenticate, requireRole("DRIVER", "HEAD_DRIVER"));

router.get("/profile", driverController.getProfile);
router.get("/trips", driverController.listTrips);
router.get("/trips/:id", driverController.getTrip);
router.post("/trips/:id/accept", driverController.acceptTrip);
router.post("/trips/:id/decline", driverController.declineTrip);
router.post("/trips/:id/depart", driverController.recordDeparture);
router.post("/trips/:id/return", driverController.recordReturn);

module.exports = router;