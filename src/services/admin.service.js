const prisma = require("../config/prisma");
const availability = require("./availability.service");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function listPendingDrivers() {
  const drivers = await prisma.user.findMany({
    where: { role: "DRIVER", isApproved: false },
    select: {
      id: true,
      email: true,
      fullName: true,
      phone: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return drivers;
}

async function approveDriver(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw httpError(404, "User not found");
  }

  if (user.role !== "DRIVER") {
    throw httpError(400, "Only driver accounts can be approved through this endpoint");
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { isApproved: true },
  });

  const { password, ...safe } = updated;
  return safe;
}

// Rejecting a pending driver application permanently deletes the account.
// Only ever called on drivers who never got approved, so they should have
// no trips/ratings/etc. attached — if they somehow do, the delete will
// fail on a foreign key constraint rather than silently orphaning data.
async function rejectDriver(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw httpError(404, "User not found");
  }

  if (user.role !== "DRIVER") {
    throw httpError(400, "Only driver accounts can be rejected through this endpoint");
  }

  if (user.isApproved) {
    throw httpError(400, "This driver is already approved — cannot reject");
  }

  await prisma.user.delete({ where: { id: userId } });
}

// Handles Driver <-> Head Driver role changes made by an Admin.
// Enforces: at most one HEAD_DRIVER can exist at any time.
async function updateUserRole(userId, newRole) {
  const allowedRoles = ["DRIVER", "HEAD_DRIVER"];
  if (!allowedRoles.includes(newRole)) {
    throw httpError(400, `role must be one of: ${allowedRoles.join(", ")}`);
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    throw httpError(404, "User not found");
  }

  if (target.role !== "DRIVER" && target.role !== "HEAD_DRIVER") {
    throw httpError(
      400,
      "This endpoint can only change the role of an existing Driver or Head Driver"
    );
  }

  if (newRole === "HEAD_DRIVER") {
    if (!target.isApproved) {
      throw httpError(400, "Driver must be approved before becoming Head Driver");
    }

    const existingHeadDriver = await prisma.user.findFirst({
      where: { role: "HEAD_DRIVER", NOT: { id: userId } },
    });

    if (existingHeadDriver) {
      throw httpError(409, "Only one Head Driver can be assigned at a time.");
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { role: newRole },
  });

  const { password, ...safe } = updated;
  return safe;
}

// Everything the Admin review screen shows, in one call.
const adminTripInclude = {
  requester: { select: { id: true, fullName: true, email: true, phone: true } },
  department: true,
  driver: { select: { id: true, fullName: true, email: true, phone: true, role: true } },
  vehicle: true,
  passengers: true,
  stops: { orderBy: { order: "asc" }, include: { location: true } },
};

async function listPendingTrips() {
  return prisma.tripRequest.findMany({
    where: { status: "PENDING" },
    include: adminTripInclude,
    orderBy: [{ isUrgent: "desc" }, { createdAt: "asc" }],
  });
}

async function approveTrip(tripId, adminId) {
  return prisma.$transaction(async (tx) => {
    const trip = await tx.tripRequest.findUnique({
      where: { id: tripId },
      include: {
        stops: { select: { travelMinutes: true } },
        driver: { select: { id: true, fullName: true, role: true } },
      },
    });

    if (!trip) {
      throw httpError(404, "Trip request not found");
    }
    if (trip.status !== "PENDING") {
      throw httpError(400, "Only pending trips can be approved");
    }

    // Two pending trips can name the same driver, so the booking is only
    // real once it is approved — check again here, inside the transaction.
    const windows = availability.computeBusyWindows(trip);
    await availability.assertAvailable(tx, {
      driverId: trip.driverId,
      vehicleId: trip.vehicleId,
      windows,
      excludeTripId: trip.id,
    });

    // When the Head Driver is the assigned driver he would only be
    // approving his own trip, so that step is skipped and the trip goes
    // straight to him to Accept or Decline. headDriverApprovedById stays
    // null, which is how the record shows the step was skipped.
    const skipsHeadDriver = trip.driver.role === "HEAD_DRIVER";

    // Without a Head Driver the trip would sit at ADMIN_APPROVED with nobody
    // able to take the next step, so the approval is blocked instead.
    let headDriver = null;
    if (!skipsHeadDriver) {
      headDriver = await tx.user.findFirst({
        where: { role: "HEAD_DRIVER", isActive: true },
        select: { id: true },
      });
      if (!headDriver) {
        throw httpError(
          409,
          "No Head Driver is assigned. Promote a driver to Head Driver in the Drivers screen before approving trips."
        );
      }
    }

    const updated = await tx.tripRequest.update({
      where: { id: tripId },
      data: {
        status: skipsHeadDriver ? "HEAD_DRIVER_APPROVED" : "ADMIN_APPROVED",
        adminApprovedById: adminId,
        adminApprovedAt: new Date(),
      },
    });

    const notifications = [
      {
        userId: trip.requesterId,
        title: "Trip Ticket Approved",
        message: skipsHeadDriver
          ? `Your trip request (${trip.ticketNumber}) was approved by the admin and sent to the driver.`
          : `Your trip request (${trip.ticketNumber}) was approved by the admin and is now with the head driver.`,
      },
    ];

    if (skipsHeadDriver) {
      notifications.push({
        userId: trip.driverId,
        title: "New Trip Assigned",
        message: `Trip ${trip.ticketNumber} is waiting for you to accept or decline.`,
      });
    } else {
      notifications.push({
        userId: headDriver.id,
        title: "Trip Needs Your Approval",
        message: `Trip ${trip.ticketNumber} was approved by the admin and needs your approval.`,
      });
    }

    await tx.notification.createMany({ data: notifications });

    return updated;
  });
}

async function rejectTrip(tripId, adminId, reason) {
  const trip = await prisma.tripRequest.findUnique({ where: { id: tripId } });
  if (!trip) {
    throw httpError(404, "Trip request not found");
  }
  if (trip.status !== "PENDING") {
    throw httpError(400, "Only pending trips can be rejected");
  }

  const updated = await prisma.tripRequest.update({
    where: { id: tripId },
    data: {
      status: "REJECTED",
      rejectedById: adminId,
      rejectedAt: new Date(),
      rejectedReason: reason || null,
    },
  });

  await prisma.notification.create({
    data: {
      userId: trip.requesterId,
      title: "Trip Ticket Rejected",
      message: reason
        ? `Your trip request (${trip.ticketNumber}) was rejected: ${reason}`
        : `Your trip request (${trip.ticketNumber}) was rejected by the admin.`,
    },
  });

  return updated;
}


// ------------------------------------------------------
// Approved drivers (Admin > Drivers screen)
// ------------------------------------------------------

const DRIVER_ROLES = ["DRIVER", "HEAD_DRIVER"]; // the Head Driver also drives
const ADMIN_SETTABLE_STATUSES = ["AVAILABLE", "OFF_DUTY"];

// Trip counts and rating averages are computed here, never stored.
async function listDrivers({ status } = {}) {
  if (status !== undefined && status !== "" && !["AVAILABLE", "ON_TRIP", "OFF_DUTY"].includes(status)) {
    throw httpError(400, "status must be AVAILABLE, ON_TRIP or OFF_DUTY");
  }

  const drivers = await prisma.user.findMany({
    where: {
      role: { in: DRIVER_ROLES },
      isApproved: true,
      ...(status ? { driverProfile: { status } } : {}),
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      avatarUrl: true,
      createdAt: true,
      driverProfile: true,
      ownedVehicle: { select: { id: true, model: true, plateNumber: true } },
    },
    orderBy: [{ role: "asc" }, { fullName: "asc" }],
  });

  if (drivers.length === 0) return [];

  const ids = drivers.map((d) => d.id);

  const [tripCounts, completedCounts, ratings] = await Promise.all([
    prisma.tripRequest.groupBy({
      by: ["driverId"],
      where: { driverId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.tripRequest.groupBy({
      by: ["driverId"],
      where: { driverId: { in: ids }, status: "COMPLETED" },
      _count: { _all: true },
    }),
    prisma.rating.groupBy({
      by: ["ratedUserId"],
      where: { ratedUserId: { in: ids } },
      _avg: { score: true },
      _count: { _all: true },
    }),
  ]);

  const totalByDriver = new Map(tripCounts.map((r) => [r.driverId, r._count._all]));
  const doneByDriver = new Map(completedCounts.map((r) => [r.driverId, r._count._all]));
  const ratingByDriver = new Map(
    ratings.map((r) => [r.ratedUserId, { avg: r._avg.score, count: r._count._all }])
  );

  return drivers.map((driver) => {
    const rating = ratingByDriver.get(driver.id);
    return {
      id: driver.id,
      fullName: driver.fullName,
      email: driver.email,
      phone: driver.phone,
      role: driver.role,
      isActive: driver.isActive,
      avatarUrl: driver.avatarUrl,
      createdAt: driver.createdAt,
      driverCode: driver.driverProfile?.driverCode ?? null,
      status: driver.driverProfile?.status ?? null,
      licenseNumber: driver.driverProfile?.licenseNumber ?? null,
      dateHired: driver.driverProfile?.dateHired ?? null,
      assignedVehicle: driver.ownedVehicle ?? null,
      totalTrips: totalByDriver.get(driver.id) ?? 0,
      completedTrips: doneByDriver.get(driver.id) ?? 0,
      averageRating: rating?.avg ?? null,
      ratingCount: rating?.count ?? 0,
    };
  });
}

// Admin can only set AVAILABLE or OFF_DUTY. ON_TRIP is set by the system
// when a trip departs and cleared when it completes — setting it by hand
// would make the field disagree with the actual trips.
async function setDriverStatus(userId, status) {
  if (!ADMIN_SETTABLE_STATUSES.includes(status)) {
    throw httpError(
      400,
      `status must be one of: ${ADMIN_SETTABLE_STATUSES.join(", ")}. ON_TRIP is set automatically.`
    );
  }

  const driver = await prisma.user.findUnique({
    where: { id: userId },
    include: { driverProfile: true },
  });

  if (!driver || !DRIVER_ROLES.includes(driver.role)) {
    throw httpError(404, "Driver not found");
  }
  if (!driver.driverProfile) {
    throw httpError(400, "This driver has no driver profile yet");
  }
  if (!driver.isApproved) {
    throw httpError(400, "Approve this driver first");
  }

  // A driver out on the road cannot be marked off duty — his return log
  // still has to be recorded.
  if (status === "OFF_DUTY") {
    const ongoing = await prisma.tripRequest.findFirst({
      where: { driverId: userId, status: "ONGOING" },
      select: { ticketNumber: true },
    });
    if (ongoing) {
      throw httpError(
        409,
        `${driver.fullName} is currently on trip ${ongoing.ticketNumber} and cannot be set off duty.`
      );
    }
  }

  const updated = await prisma.driverProfile.update({
    where: { userId },
    data: { status },
  });

  await prisma.notification.create({
    data: {
      userId,
      title: status === "OFF_DUTY" ? "Marked Off Duty" : "Back On Duty",
      message:
        status === "OFF_DUTY"
          ? "The admin marked you off duty. You will not be assigned new trips until this changes."
          : "The admin marked you available. You can be assigned new trips again.",
    },
  });

  return updated;
}

module.exports = {
  listPendingDrivers,
  approveDriver,
  rejectDriver,
  updateUserRole,
  listDrivers,
  setDriverStatus,
  listPendingTrips,
  approveTrip,
  rejectTrip,
};