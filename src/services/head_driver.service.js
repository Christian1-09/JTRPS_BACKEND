const prisma = require("../config/prisma");
const availability = require("./availability.service");

const DRIVER_ROLES = ["DRIVER", "HEAD_DRIVER"]; // the Head Driver also drives

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Everything the Head Driver's review screen shows.
const tripInclude = {
  requester: { select: { id: true, fullName: true, email: true, phone: true } },
  department: true,
  driver: { select: { id: true, fullName: true, phone: true, role: true } },
  vehicle: true,
  passengers: true,
  stops: { orderBy: { order: "asc" }, include: { location: true } },
  driverDeclines: {
    orderBy: { declinedAt: "desc" },
    include: { driver: { select: { id: true, fullName: true } } },
  },
};

async function notifyAdmins(client, { title, message }) {
  const admins = await client.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  if (admins.length === 0) return;
  await client.notification.createMany({
    data: admins.map((a) => ({ userId: a.id, title, message })),
  });
}

// ------------------------------------------------------
// Approval queue
// ------------------------------------------------------

// Trips the Admin approved that now need the Head Driver's approval.
// Trips where he is the assigned driver never reach here — that step is
// skipped, and they appear in his own assigned-trips list instead.
async function listPendingApprovals(headDriverId) {
  return prisma.tripRequest.findMany({
    where: {
      status: "ADMIN_APPROVED",
      NOT: { driverId: headDriverId },
    },
    include: tripInclude,
    orderBy: [{ isUrgent: "desc" }, { adminApprovedAt: "asc" }],
  });
}

async function approveTrip(tripId, headDriverId) {
  return prisma.$transaction(async (tx) => {
    const trip = await tx.tripRequest.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        ticketNumber: true,
        status: true,
        requesterId: true,
        driverId: true,
      },
    });

    if (!trip) {
      throw httpError(404, "Trip request not found");
    }
    if (trip.status !== "ADMIN_APPROVED") {
      throw httpError(400, "Only trips approved by the admin can be approved here");
    }
    if (trip.driverId === headDriverId) {
      throw httpError(400, "You are the assigned driver for this trip — accept or decline it instead");
    }

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: {
        status: "HEAD_DRIVER_APPROVED",
        headDriverApprovedById: headDriverId,
        headDriverApprovedAt: new Date(),
      },
    });

    await tx.notification.createMany({
      data: [
        {
          userId: trip.requesterId,
          title: "Trip Ticket Approved",
          message: `Your trip request (${trip.ticketNumber}) was approved by the head driver and sent to the driver.`,
        },
        {
          userId: trip.driverId,
          title: "New Trip Assigned",
          message: `Trip ${trip.ticketNumber} is waiting for you to accept or decline.`,
        },
      ],
    });

    return updated;
  });
}

async function rejectTrip(tripId, headDriverId, reason) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) {
    throw httpError(400, "A reason is required when rejecting a trip");
  }

  return prisma.$transaction(async (tx) => {
    const trip = await tx.tripRequest.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        ticketNumber: true,
        status: true,
        requesterId: true,
        driverId: true,
      },
    });

    if (!trip) {
      throw httpError(404, "Trip request not found");
    }
    if (trip.status !== "ADMIN_APPROVED") {
      throw httpError(400, "Only trips approved by the admin can be rejected here");
    }

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: {
        status: "REJECTED",
        rejectedById: headDriverId,
        rejectedAt: new Date(),
        rejectedReason: cleanReason,
      },
    });

    // The requester AND the admin are told, since the admin already
    // approved this trip and needs to know it did not go through.
    await tx.notification.create({
      data: {
        userId: trip.requesterId,
        title: "Trip Ticket Rejected",
        message: `Your trip request (${trip.ticketNumber}) was rejected by the head driver: ${cleanReason}`,
      },
    });

    await notifyAdmins(tx, {
      title: "Trip Rejected by Head Driver",
      message: `Trip ${trip.ticketNumber} was rejected by the head driver: ${cleanReason}`,
    });

    return updated;
  });
}

// ------------------------------------------------------
// Replacing a driver who declined
// ------------------------------------------------------

async function listDeclinedTrips() {
  return prisma.tripRequest.findMany({
    where: { status: "DRIVER_DECLINED" },
    include: tripInclude,
    orderBy: [{ isUrgent: "desc" }, { departureTime: "asc" }],
  });
}

async function loadDeclinedTripOrThrow(client, tripId) {
  const trip = await client.tripRequest.findUnique({
    where: { id: tripId },
    include: {
      stops: { select: { travelMinutes: true } },
      driverDeclines: { select: { driverId: true } },
    },
  });

  if (!trip) {
    throw httpError(404, "Trip request not found");
  }
  if (trip.status !== "DRIVER_DECLINED") {
    throw httpError(400, "This trip is not waiting for a replacement driver");
  }

  return trip;
}

// Drivers who are free for this trip's time windows. Anyone who already
// declined it is left out — including the head driver himself if he did.
async function listReplacementDrivers(tripId) {
  const trip = await loadDeclinedTripOrThrow(prisma, tripId);
  const declinedIds = trip.driverDeclines.map((d) => d.driverId);

  const drivers = await prisma.user.findMany({
    where: {
      role: { in: DRIVER_ROLES },
      isApproved: true,
      isActive: true,
      driverProfile: { status: { not: "OFF_DUTY" } },
      NOT: { id: { in: [...declinedIds, trip.driverId] } },
    },
    select: { id: true, fullName: true, email: true, phone: true, role: true },
    orderBy: { fullName: "asc" },
  });

  if (drivers.length === 0) return [];

  const windows = availability.computeBusyWindows(trip);
  const busy = await availability.findBusyDriverIds(prisma, {
    windows,
    excludeTripId: trip.id, // this trip's own booking must not block itself
  });

  return drivers.filter((d) => !busy.has(d.id));
}

async function reassignDriver(tripId, newDriverId, headDriverId) {
  if (!newDriverId) {
    throw httpError(400, "driverId is required");
  }

  return prisma.$transaction(async (tx) => {
    const trip = await loadDeclinedTripOrThrow(tx, tripId);

    if (trip.driverDeclines.some((d) => d.driverId === newDriverId)) {
      throw httpError(400, "This driver already declined this trip");
    }

    const driver = await tx.user.findUnique({
      where: { id: newDriverId },
      include: { driverProfile: true },
    });

    if (!driver || !DRIVER_ROLES.includes(driver.role)) {
      throw httpError(404, "Driver not found");
    }
    if (!driver.isApproved || !driver.isActive) {
      throw httpError(400, "This driver is not available for assignment");
    }
    if (driver.driverProfile?.status === "OFF_DUTY") {
      throw httpError(400, "This driver is off duty");
    }

    const windows = availability.computeBusyWindows(trip);
    await availability.assertAvailable(tx, {
      driverId: newDriverId,
      vehicleId: trip.vehicleId,
      windows,
      excludeTripId: trip.id,
    });

    // Back to "waiting for the driver to accept". The admin's and head
    // driver's approvals still stand — only the driver changed.
    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: {
        driverId: newDriverId,
        status: "HEAD_DRIVER_APPROVED",
        headDriverApprovedById: headDriverId,
        headDriverApprovedAt: new Date(),
        driverAcceptedAt: null,
      },
    });

    await tx.notification.createMany({
      data: [
        {
          userId: newDriverId,
          title: "New Trip Assigned",
          message: `Trip ${trip.ticketNumber} is waiting for you to accept or decline.`,
        },
        {
          userId: trip.requesterId,
          title: "New Driver Assigned",
          message: `${driver.fullName} was assigned to your trip (${trip.ticketNumber}) after the previous driver declined.`,
        },
      ],
    });

    return updated;
  });
}

module.exports = {
  listPendingApprovals,
  approveTrip,
  rejectTrip,
  listDeclinedTrips,
  listReplacementDrivers,
  reassignDriver,
};