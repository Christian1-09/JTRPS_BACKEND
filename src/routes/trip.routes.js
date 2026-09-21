const express = require("express");
const multer = require("multer");
const router = express.Router();
const tripController = require("../controllers/trip.controller");
const authenticate = require("../middleware/auth");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB — covers a scanned PDF or photo
});

// One optional file field alongside the text fields.
const tripUpload = upload.fields([
  { name: "authorizationLetter", maxCount: 1 },
]);

router.post("/", authenticate, tripUpload, tripController.createTripRequest);
router.get("/mine", authenticate, tripController.listMyTrips);
router.get("/departments", authenticate, tripController.listDepartments);
router.get("/locations", authenticate, tripController.listLocations);
router.get("/drivers/available", authenticate, tripController.listAvailableDrivers);
router.get("/vehicles/available", authenticate, tripController.listAvailableVehicles);

module.exports = router;