const vehicleService = require("../services/vehicle.service");

async function listAllVehicles(req, res, next) {
  try {
    const vehicles = await vehicleService.listAllVehicles();
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
}

async function createVehicle(req, res, next) {
  try {
    const { model, plateNumber, type, capacity, year, odometerCurrent,assignments } = req.body;

    if (!model || !plateNumber || !type || !capacity) {
      return res.status(400).json({
        message: "model, plateNumber, type, and capacity are required",
      });
    }

    const imageFile = req.file || null;

    const vehicle = await vehicleService.createVehicle({
      model,
      plateNumber,
      type,
      capacity,
      year,
      odometerCurrent,
      imageFile,
      assignments,
    });

    res.status(201).json({ vehicle });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ message: "A vehicle with this plate number already exists" });
    }
    next(err);
  }
}

module.exports = { listAllVehicles, createVehicle };