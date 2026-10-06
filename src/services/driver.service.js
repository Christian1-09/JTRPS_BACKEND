const prisma = require("../config/prisma");

const DRIVER_ROLES = ["DRIVER", "HEAD_DRIVER"];
const ACTIVE_STATUSES = ["HEAD_DRIVER_APPROVED", "DRIVER_ACCEPTED", "ONGOING"];
const DECLINABLE_STATUSES = ["HEAD_DRIVER_APPROVED", "DRIVER_ACCEPTED"];

// A departure can be recorded from this many minutes before the scheduled
// time. There is no cutoff for being late — the actual time comes from the
// server clock, so lateness shows up in the timeline instead of blocking.
const DEPART_EARLY_WINDOW_MINUTES = 120;
const TIME_ZONE = "Asia/Manila";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

// Numbers arrive as JSON numbers or strings; both are accepted.
function parseNumber(value, field, { integer = false, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw httpError(400, `${field} is required`);
  }
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isFinite(num) || num < 0) {
    throw httpError(400, `${field} must be a number of 0 or more`);
  }
  if (integer && !Number.isInteger(num)) {
    throw httpError(400, `${field} must be a whole number`);
  }
  return num;
}

const tripInclude = {
  requester: { select: { id: true, fullName: true, email: true, phone: true } },
  department: true,
  driver: { select: { id: true, fullName: true, phone: true, role: true } },
  vehicle: true,
  passengers: true,
  stops: { orderBy: { order: "asc" }, include: { location: true } },
  departure: true,
  arrival: true,
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

// Loads a trip that belongs to this driver, or throws.
async function loadOwnTrip(client, driverId, tripId, include = undefined) {
  const trip = await client.tripRequest.findUnique({
    where: { id: tripId },
    ...(include ? { include } : {}),
  });
  if (!trip || trip.driverId !== driverId) {
    throw httpError(404, "Trip not found");
  }
  return trip;
}

// ------------------------------------------------------
// Reads
// ------------------------------------------------------

// Header + stats for the driver's home screen. Counts and the rating
// average are computed here, never stored.
async function getProfile(driverId) {
  const user = await prisma.user.findUnique({
    where: { id: driverId },
    select: {
      id: true,
      fullName: true,
      role: true,
      avatarUrl: true,
      driverProfile: true,
    },
  });
  if (!user || !DRIVER_ROLES.includes(user.role)) {
    throw httpError(404, "Driver not found");
  }

  const [awaiting, upcoming, ongoing, completed, rating] = await Promise.all([
    prisma.tripRequest.count({ where: { driverId, status: "HEAD_DRIVER_APPROVED" } }),
    prisma.tripRequest.count({ where: { driverId, status: "DRIVER_ACCEPTED" } }),
    prisma.tripRequest.count({ where: { driverId, status: "ONGOING" } }),
    prisma.tripRequest.count({ where: { driverId, status: "COMPLETED" } }),
    prisma.rating.aggregate({
      where: { ratedUserId: driverId },
      _avg: { score: true },
      _count: { _all: true },
    }),
  ]);

  return {
    id: user.id,
    fullName: user.fullName,
    role: user.role,
    avatarUrl: user.avatarUrl,
    driverCode: user.driverProfile?.driverCode ?? null,
    status: user.driverProfile?.status ?? null,
    awaitingCount: awaiting,
    upcomingCount: upcoming,
    ongoingCount: ongoing,
    completedCount: completed,
    averageRating: rating._avg.score,
    ratingCount: rating._count._all,
  };
}

// scope "active": waiting to accept, accepted, or ongoing (soonest first).
// scope "history": completed trips (most recent first).
async function listTrips(driverId, scope = "active") {
  if (scope === "history") {
    return prisma.tripRequest.findMany({
      where: { driverId, status: "COMPLETED" },
      include: tripInclude,
      orderBy: { departureTime: "desc" },
      take: 100,
    });
  }
  if (scope !== "active") {
    throw httpError(400, "scope must be 'active' or 'history'");
  }
  return prisma.tripRequest.findMany({
    where: { driverId, status: { in: ACTIVE_STATUSES } },
    include: tripInclude,
    orderBy: [{ departureTime: "asc" }],
  });
}

async function getTrip(driverId, tripId) {
  return loadOwnTrip(prisma, driverId, tripId, tripInclude);
}

// ------------------------------------------------------
// Accept / Decline
// ------------------------------------------------------

async function acceptTrip(driverId, tripId) {
  return prisma.$transaction(async (tx) => {
    const trip = await loadOwnTrip(tx, driverId, tripId);
    if (trip.status !== "HEAD_DRIVER_APPROVED") {
      throw httpError(400, "Only trips waiting for your answer can be accepted");
    }

    const profile = await tx.driverProfile.findUnique({ where: { userId: driverId } });
    if (profile?.status === "OFF_DUTY") {
      throw httpError(400, "You are marked off duty. Ask the admin to set you available first.");
    }

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: { status: "DRIVER_ACCEPTED", driverAcceptedAt: new Date() },
    });

    await tx.notification.create({
      data: {
        userId: trip.requesterId,
        title: "Driver Confirmed",
        message: `Your trip (${trip.ticketNumber}) was accepted by the driver.`,
      },
    });

    return updated;
  });
}

// Allowed while waiting for an answer AND after accepting (for example the
// driver fell sick). Either way it goes to the Head Driver to reassign.
async function declineTrip(driverId, tripId, reason) {
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) {
    throw httpError(400, "Please give a reason for declining");
  }

  return prisma.$transaction(async (tx) => {
    const trip = await loadOwnTrip(tx, driverId, tripId);
    if (!DECLINABLE_STATUSES.includes(trip.status)) {
      throw httpError(400, "This trip can no longer be declined");
    }

    const driver = await tx.user.findUnique({
      where: { id: driverId },
      select: { fullName: true },
    });

    try {
      await tx.tripDriverDecline.create({
        data: { tripRequestId: tripId, driverId, reason: cleanReason },
      });
    } catch (err) {
      if (err?.code === "P2002") {
        throw httpError(400, "You already declined this trip");
      }
      throw err;
    }

    // driverId stays on the trip so the Head Driver can see who declined;
    // DRIVER_DECLINED no longer blocks that driver's schedule.
    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: { status: "DRIVER_DECLINED", driverAcceptedAt: null },
    });

    const headDriver = await tx.user.findFirst({
      where: { role: "HEAD_DRIVER", isActive: true },
      select: { id: true },
    });

    const notifications = [
      {
        userId: trip.requesterId,
        title: "Driver Unavailable",
        message: `The driver for your trip (${trip.ticketNumber}) is unavailable. A new driver is being assigned.`,
      },
    ];
    if (headDriver) {
      notifications.push({
        userId: headDriver.id,
        title: "Trip Needs a New Driver",
        message: `${driver.fullName} declined trip ${trip.ticketNumber}: ${cleanReason}`,
      });
    }
    await tx.notification.createMany({ data: notifications });

    await notifyAdmins(tx, {
      title: "Driver Declined a Trip",
      message: headDriver
        ? `${driver.fullName} declined trip ${trip.ticketNumber}: ${cleanReason}`
        : `${driver.fullName} declined trip ${trip.ticketNumber}, and no Head Driver is assigned to pick a replacement.`,
    });

    return updated;
  });
}

// ------------------------------------------------------
// Departure / Return
// ------------------------------------------------------

async function recordDeparture(driverId, tripId, body) {
  const odometerStart = parseNumber(body.odometerStart, "odometerStart", { integer: true });
  const fuelBalanceInTank = parseNumber(body.fuelBalanceInTank, "fuelBalanceInTank");
  const fuelIssuedByOffice = parseNumber(body.fuelIssuedByOffice, "fuelIssuedByOffice");
  const fuelPurchasedDuring = parseNumber(body.fuelPurchasedDuring, "fuelPurchasedDuring");

  return prisma.$transaction(async (tx) => {
    const trip = await loadOwnTrip(tx, driverId, tripId, { vehicle: true });
    if (trip.status !== "DRIVER_ACCEPTED") {
      throw httpError(400, "Accept the trip before recording the departure");
    }

    const now = new Date();
    const opensAt = new Date(
      trip.departureTime.getTime() - DEPART_EARLY_WINDOW_MINUTES * 60 * 1000
    );
    if (now < opensAt) {
      throw httpError(
        400,
        `Too early to depart. You can record the departure from ${formatDateTime(opensAt)}.`
      );
    }

    const profile = await tx.driverProfile.findUnique({ where: { userId: driverId } });
    if (profile?.status === "OFF_DUTY") {
      throw httpError(400, "You are marked off duty. Ask the admin to set you available first.");
    }

    if (["MAINTENANCE", "INACTIVE"].includes(trip.vehicle.status)) {
      throw httpError(
        400,
        `${trip.vehicle.model} (${trip.vehicle.plateNumber}) is marked ${trip.vehicle.status.toLowerCase()} and cannot depart. Contact the admin.`
      );
    }

    if (trip.vehicle.odometerCurrent != null && odometerStart < trip.vehicle.odometerCurrent) {
      throw httpError(
        400,
        `The odometer cannot be lower than the vehicle's last recorded reading (${trip.vehicle.odometerCurrent} km).`
      );
    }

    // Computed by the server so it can never disagree with its parts.
    const totalAvailableLiters = round2(
      fuelBalanceInTank + fuelIssuedByOffice + fuelPurchasedDuring
    );

    await tx.tripDeparture.create({
      data: {
        tripRequestId: tripId,
        departureTime: now,
        odometerStart,
        fuelBalanceInTank,
        fuelIssuedByOffice,
        fuelPurchasedDuring,
        totalAvailableLiters,
      },
    });

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: { status: "ONGOING" },
    });

    await tx.driverProfile.update({
      where: { userId: driverId },
      data: { status: "ON_TRIP" },
    });
    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: { status: "ON_TRIP" },
    });

    await tx.notification.create({
      data: {
        userId: trip.requesterId,
        title: "Trip Departed",
        message: `Your trip (${trip.ticketNumber}) has departed.`,
      },
    });

    return updated;
  });
}

function parseDateTime(value, field) {
  if (value === undefined || value === null || value === "") {
    throw httpError(400, `${field} is required`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `${field} is not a valid time`);
  }
  return date;
}

async function recordReturn(driverId, tripId, body) {
  const odometerEnd = parseNumber(body.odometerEnd, "odometerEnd", { integer: true });
  const arrivedAtDestination = parseDateTime(body.arrivedAtDestination, "arrivedAtDestination");
  const departedFromDestination = parseDateTime(
    body.departedFromDestination,
    "departedFromDestination"
  );
  const balanceInTankLiters = parseNumber(body.balanceInTankLiters, "balanceInTankLiters");
  const gearOilUsedLiters = parseNumber(body.gearOilUsedLiters, "gearOilUsedLiters", { required: false });
  const lubricatingOilUsedLiters = parseNumber(body.lubricatingOilUsedLiters, "lubricatingOilUsedLiters", { required: false });
  const greaseIssuedLiters = parseNumber(body.greaseIssuedLiters, "greaseIssuedLiters", { required: false });
  const remarks = String(body.remarks || "").trim() || null;

  return prisma.$transaction(async (tx) => {
    const trip = await loadOwnTrip(tx, driverId, tripId, { departure: true, vehicle: true });
    if (trip.status !== "ONGOING" || !trip.departure) {
      throw httpError(400, "Record the departure before recording the return");
    }

    if (odometerEnd < trip.departure.odometerStart) {
      throw httpError(
        400,
        `The odometer at return (${odometerEnd}) cannot be lower than at departure (${trip.departure.odometerStart}).`
      );
    }
    // Items 2 and 3 of the printed ticket must sit inside the trip:
    // garage -> destination -> destination -> garage.
    const arrivalTime = new Date();
    if (arrivedAtDestination < trip.departure.departureTime) {
      throw httpError(400, "The arrival at the destination cannot be before the departure.");
    }
    if (departedFromDestination < arrivedAtDestination) {
      throw httpError(
        400,
        "The departure from the destination cannot be before arriving there."
      );
    }
    if (departedFromDestination > arrivalTime) {
      throw httpError(400, "The departure from the destination cannot be in the future.");
    }

    if (balanceInTankLiters > trip.departure.totalAvailableLiters) {
      throw httpError(
        400,
        `The fuel left (${balanceInTankLiters} L) cannot be more than the fuel available at departure (${trip.departure.totalAvailableLiters} L).`
      );
    }

    // Both computed by the server, never typed by the driver.
    const distanceTraveledKm = odometerEnd - trip.departure.odometerStart;
    const gasolineUsedLiters = round2(trip.departure.totalAvailableLiters - balanceInTankLiters);

    await tx.tripReturn.create({
      data: {
        tripRequestId: tripId,
        arrivalTime,
        odometerEnd,
        arrivedAtDestination,
        departedFromDestination,
        distanceTraveledKm,
        gasolineUsedLiters,
        balanceInTankLiters,
        gearOilUsedLiters,
        lubricatingOilUsedLiters,
        greaseIssuedLiters,
        remarks,
      },
    });

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: { status: "COMPLETED" },
    });

    // Drop-off trips can overlap, so the driver/vehicle only go back to
    // free when no OTHER trip of theirs is still on the road.
    const [driverStillOut, vehicleStillOut] = await Promise.all([
      tx.tripRequest.count({
        where: { driverId, status: "ONGOING", NOT: { id: tripId } },
      }),
      tx.tripRequest.count({
        where: { vehicleId: trip.vehicleId, status: "ONGOING", NOT: { id: tripId } },
      }),
    ]);

    const profile = await tx.driverProfile.findUnique({ where: { userId: driverId } });
    if (profile?.status === "ON_TRIP" && driverStillOut === 0) {
      await tx.driverProfile.update({
        where: { userId: driverId },
        data: { status: "AVAILABLE" },
      });
    }

    // Only undo the status we set: if the admin moved the vehicle to
    // maintenance during the trip, that choice is kept.
    await tx.vehicle.update({
      where: { id: trip.vehicleId },
      data: {
        odometerCurrent: Math.max(trip.vehicle.odometerCurrent ?? 0, odometerEnd),
        ...(trip.vehicle.status === "ON_TRIP" && vehicleStillOut === 0
          ? { status: "ACTIVE" }
          : {}),
      },
    });

    await tx.notification.create({
      data: {
        userId: trip.requesterId,
        title: "Trip Completed",
        message: `Your trip (${trip.ticketNumber}) is complete. You can now rate your driver.`,
      },
    });

    return updated;
  });
}

module.exports = {
  getProfile,
  listTrips,
  getTrip,
  acceptTrip,
  declineTrip,
  recordDeparture,
  recordReturn,
};