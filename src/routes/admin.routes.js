const express = require("express");
const router = express.Router();
const adminController = require("../controllers/admin.controller");
const vehicleRoutes = require("./vehicle.routes");
const locationRoutes = require("./location.routes");
const authenticate = require("../middleware/auth");
const requireRole = require("../middleware/roleCheck");

// Every route here requires a logged-in Admin.
router.use(authenticate, requireRole("ADMIN"));

// "/drivers/pending" must stay ABOVE "/drivers/:id/..." routes so that
// "pending" is never read as an id.
router.get("/drivers/pending", adminController.listPendingDrivers);
router.get("/drivers", adminController.listDrivers);
router.post("/drivers/:id/approve", adminController.approveDriver);
router.post("/drivers/:id/reject", adminController.rejectDriver);
router.patch("/drivers/:id/status", adminController.setDriverStatus);
router.patch("/users/:id/role", adminController.updateUserRole);

router.get("/trips/pending", adminController.listPendingTrips);
router.post("/trips/:id/approve", adminController.approveTrip);
router.post("/trips/:id/reject", adminController.rejectTrip);

router.use("/vehicles", vehicleRoutes); // GET/POST /api/admin/vehicles
router.use("/locations", locationRoutes); // GET/POST/PATCH/DELETE /api/admin/locations

module.exports = router;