const prisma = require("../config/prisma");
const storageService = require("./storage.service");

// Returns every vehicle regardless of status, with a computed trip count —
// "trips" isn't a stored column, it's derived from how many TripRequests
// reference this vehicle (same principle as not storing driver trip counts).
async function listAllVehicles() {
  const vehicles = await prisma.vehicle.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { tripRequests: true } } },
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
    createdAt: v.createdAt,
  }));
}

async function createVehicle({ model, plateNumber, type, capacity, year, odometerCurrent, imageFile }) {
  let imageUrl = null;
  if (imageFile) {
    imageUrl = await storageService.saveFile(imageFile.buffer, imageFile.originalname, "vehicles");
  }

  return prisma.vehicle.create({
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
}

module.exports = { listAllVehicles, createVehicle };