const prisma = require("../config/prisma");
const storageService = require("./storage.service");
const adminService = require("./admin.service");

// Returns every vehicle regardless of status, with a computed trip count —
// "trips" isn't a stored column, it's derived from how many TripRequests
// reference this vehicle (same principle as not storing driver trip counts).
async function listAllVehicles() {
  const vehicles = await prisma.vehicle.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { tripRequests: true } },
      assignments: {
        orderBy: [{ isPrimary: "desc" }, { assignedAt: "asc" }],
        select: {
          isPrimary: true,
          driver: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
              driverProfile: { select: { driverCode: true } },
            },
          },
        },
      },
    },
  });

  return vehicles.map((v) => ({
    id: v.id,
    model: v.model,
    plateNumber: v.plateNumber,
    type: v.type,
    capacity: v.capacity,
    year: v.year,
    fuelType: v.fuelType,
    odometerCurrent: v.odometerCurrent,
    imageUrl: v.imageUrl,
    status: v.status,
    trips: v._count.tripRequests,
    // Flattened so the Flutter side never has to dig through the join row.
    drivers: v.assignments.map((a) => ({
      id: a.driver.id,
      fullName: a.driver.fullName,
      avatarUrl: a.driver.avatarUrl,
      driverCode: a.driver.driverProfile?.driverCode ?? null,
      isPrimary: a.isPrimary,
    })),
    createdAt: v.createdAt,
  }));
}

async function createVehicle({
  model,
  plateNumber,
  type,
  capacity,
  year,
  odometerCurrent,
  imageFile,
  assignments,
}) {
  let imageUrl = null;
  if (imageFile) {
    imageUrl = await storageService.saveFile(
      imageFile.buffer,
      imageFile.originalname,
      "vehicles"
    );
  }

  const vehicle = await prisma.vehicle.create({
    data: {
      model,
      plateNumber,
      type,
      capacity: Number(capacity),
      year: year ? Number(year) : null,
      odometerCurrent: odometerCurrent ? Number(odometerCurrent) : null,
      imageUrl,
      status: "ACTIVE",
    },
  });

  // Optional. Multipart fields are strings, so the driver list arrives as
  // JSON: '[{"driverId":"…","isPrimary":true}]'
  //
  // Done in the same request so a vehicle can never end up saved with its
  // drivers missing because a second call failed.
  if (assignments) {
    let parsed = [];
    try {
      parsed = JSON.parse(assignments);
    } catch {
      const err = new Error("assignments must be valid JSON.");
      err.status = 400;
      throw err;
    }
    await adminService.setVehicleDrivers(vehicle.id, parsed);
  }

  return vehicle;
}

module.exports = { listAllVehicles, createVehicle };