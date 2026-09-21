const express = require("express");
const router = express.Router();
const locationController = require("../controllers/location.controller");

// Mounted at /api/admin/locations inside admin.routes.js,
// which already requires a logged-in Admin for every route.

router.get("/", locationController.listLocations);
router.get("/:id", locationController.getLocation);
router.post("/", locationController.createLocation);
router.patch("/:id", locationController.updateLocation);
router.delete("/:id", locationController.deleteLocation);

module.exports = router;