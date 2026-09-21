const express = require("express");
const router = express.Router();
const headDriverController = require("../controllers/head_driver.controller");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/roleCheck");

// Only the Head Driver. The Admin deliberately cannot act here: if nobody
// holds the role, trip approval is blocked until one is assigned.
router.use(authenticate, requireRole("HEAD_DRIVER"));

// Fixed paths must stay ABOVE the ":id" routes so "pending" and "declined"
// are never read as trip ids.
router.get("/trips/pending", headDriverController.listPendingApprovals);
router.get("/trips/declined", headDriverController.listDeclinedTrips);

router.post("/trips/:id/approve", headDriverController.approveTrip);
router.post("/trips/:id/reject", headDriverController.rejectTrip);
router.get("/trips/:id/replacement-drivers", headDriverController.listReplacementDrivers);
router.post("/trips/:id/reassign", headDriverController.reassignDriver);

module.exports = router;