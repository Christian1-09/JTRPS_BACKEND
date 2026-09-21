const express = require("express");
const multer = require("multer");
const router = express.Router();
const vehicleController = require("../controllers/vehicle.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// No auth middleware here — this router is mounted inside admin.routes.js,
// which already applies authenticate + requireRole("ADMIN") to everything
// under it.
router.get("/", vehicleController.listAllVehicles);
router.post("/", upload.single("image"), vehicleController.createVehicle);

module.exports = router;