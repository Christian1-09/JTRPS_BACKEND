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
      vehicleAssignments: {
        orderBy: [{ isPrimary: "desc" }, { assignedAt: "asc" }],
        select: {
          isPrimary: true,
          vehicle: { select: { id: true, model: true, plateNumber: true } },
        },
      },
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
           // The full list, now that a driver can have several vehicles.
      assignedVehicles: driver.vehicleAssignments.map((a) => ({
        id: a.vehicle.id,
        model: a.vehicle.model,
        plateNumber: a.vehicle.plateNumber,
        isPrimary: a.isPrimary,
      })),

      // Kept so the existing admin Drivers table keeps rendering without a
      // Flutter change. It's the primary vehicle, or the first assigned one.
      // Delete this once that screen reads assignedVehicles instead.
      assignedVehicle: driver.vehicleAssignments.length > 0
        ? {
            id: driver.vehicleAssignments[0].vehicle.id,
            model: driver.vehicleAssignments[0].vehicle.model,
            plateNumber: driver.vehicleAssignments[0].vehicle.plateNumber,
          }
        : null,
      // New DriverProfile fields, while we're here.
      employeeId: driver.driverProfile?.employeeId ?? null,
      incidentCount: driver.driverProfile?.incidentCount ?? 0,

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


// ------------------------------------------------------
// Trip Ticket Log — every trip, filterable
// ------------------------------------------------------

const LOG_STATUSES = [
  "PENDING",
  "ADMIN_APPROVED",
  "HEAD_DRIVER_APPROVED",
  "DRIVER_ACCEPTED",
  "DRIVER_DECLINED",
  "REJECTED",
  "ONGOING",
  "COMPLETED",
];

const MAX_LOG_PAGE = 200;

function parseDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, `${field} is not a valid date`);
  }
  return date;
}

// The whole history, not just pending. Paged because this list only grows.
async function listAllTrips(query = {}) {
  const { status, departmentId, search, from, to, printed } = query;

  const take = Math.min(Number(query.limit) || 50, MAX_LOG_PAGE);
  const skip = Math.max(Number(query.offset) || 0, 0);

  if (status && !LOG_STATUSES.includes(status)) {
    throw httpError(400, `status must be one of: ${LOG_STATUSES.join(", ")}`);
  }

  const fromDate = parseDate(from, "from");
  const toDate = parseDate(to, "to");

  const where = {
    ...(status ? { status } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(printed === "true" ? { printedAt: { not: null } } : {}),
    ...(printed === "false" ? { printedAt: null } : {}),
    ...(fromDate || toDate
      ? {
          date: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
    ...(search && search.trim()
      ? {
          OR: [
            { ticketNumber: { contains: search.trim(), mode: "insensitive" } },
            { purpose: { contains: search.trim(), mode: "insensitive" } },
            { requester: { fullName: { contains: search.trim(), mode: "insensitive" } } },
            { driver: { fullName: { contains: search.trim(), mode: "insensitive" } } },
            { vehicle: { plateNumber: { contains: search.trim(), mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [trips, total] = await Promise.all([
    prisma.tripRequest.findMany({
      where,
      include: {
        requester: { select: { id: true, fullName: true, email: true, phone: true } },
        department: true,
        driver: { select: { id: true, fullName: true, phone: true, role: true } },
        vehicle: true,
        passengers: true,
        stops: { orderBy: { order: "asc" }, include: { location: true } },
        departure: true,
        arrival: true,
        rating: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take,
      skip,
    }),
    prisma.tripRequest.count({ where }),
  ]);

  return { trips, total, limit: take, offset: skip };
}

// ------------------------------------------------------
// Vehicle status (Admin)
// ------------------------------------------------------
// Lives here rather than in vehicle.service.js only because this endpoint
// was added later; it can be moved there without changing behaviour.

const ADMIN_SETTABLE_VEHICLE_STATUSES = ["ACTIVE", "MAINTENANCE", "INACTIVE"];

async function setVehicleStatus(vehicleId, status) {
  if (!ADMIN_SETTABLE_VEHICLE_STATUSES.includes(status)) {
    throw httpError(
      400,
      `status must be one of: ${ADMIN_SETTABLE_VEHICLE_STATUSES.join(", ")}. ON_TRIP is set automatically when a trip departs.`
    );
  }

  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) {
    throw httpError(404, "Vehicle not found");
  }

  // A vehicle out on the road cannot be parked in maintenance — its return
  // log still has to be recorded against it.
  const ongoing = await prisma.tripRequest.findFirst({
    where: { vehicleId, status: "ONGOING" },
    select: { ticketNumber: true },
  });
  if (ongoing) {
    throw httpError(
      409,
      `${vehicle.model} (${vehicle.plateNumber}) is on trip ${ongoing.ticketNumber} and its status cannot be changed yet.`
    );
  }

  const updated = await prisma.vehicle.update({
    where: { id: vehicleId },
    data: { status },
  });

  // Trips already booked on this vehicle are NOT cancelled — the admin is
  // told which ones are affected so they can reassign or reject them.
  let affectedTrips = [];
  if (status !== "ACTIVE") {
    affectedTrips = await prisma.tripRequest.findMany({
      where: {
        vehicleId,
        status: {
          in: ["PENDING", "ADMIN_APPROVED", "HEAD_DRIVER_APPROVED", "DRIVER_ACCEPTED"],
        },
        departureTime: { gte: new Date() },
      },
      select: {
        id: true,
        ticketNumber: true,
        departureTime: true,
        requester: { select: { fullName: true } },
      },
      orderBy: { departureTime: "asc" },
    });
  }

  return { vehicle: updated, affectedTrips };
}


// Edit a vehicle's details. The photo is not changed here — that needs a
// multipart upload, which the create endpoint already handles.
async function updateVehicle(vehicleId, body) {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) {
    throw httpError(404, "Vehicle not found");
  }

  const data = {};

  function text(field, { maxLength = 60, required = false } = {}) {
    if (body[field] === undefined) return;
    const value = String(body[field] ?? "").trim().replace(/\s+/g, " ");
    if (!value) {
      if (required) throw httpError(400, `${field} cannot be empty`);
      data[field] = null;
      return;
    }
    if (value.length > maxLength) {
      throw httpError(400, `${field} must be ${maxLength} characters or less`);
    }
    data[field] = value;
  }

  function integer(field, { min = 0, max = 10_000_000 } = {}) {
    if (body[field] === undefined) return;
    const raw = body[field];
    if (raw === null || raw === "") {
      data[field] = null;
      return;
    }
    const num = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (!Number.isInteger(num) || num < min || num > max) {
      throw httpError(400, `${field} must be a whole number from ${min} to ${max}`);
    }
    data[field] = num;
  }

  text("model", { required: true });
  text("type", { required: true });
  text("fuelType");
  integer("capacity", { min: 1, max: 200 });
  integer("year", { min: 1950, max: new Date().getFullYear() + 1 });
  integer("odometerCurrent");

  if (body.plateNumber !== undefined) {
    const plate = String(body.plateNumber ?? "").trim().toUpperCase();
    if (!plate) throw httpError(400, "plateNumber cannot be empty");

    const duplicate = await prisma.vehicle.findFirst({
      where: {
        plateNumber: { equals: plate, mode: "insensitive" },
        NOT: { id: vehicleId },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw httpError(409, `Another vehicle already uses plate number ${plate}`);
    }
    data.plateNumber = plate;
  }

  if (Object.keys(data).length === 0) {
    throw httpError(400, "No vehicle fields were provided to update");
  }

  try {
    return await prisma.vehicle.update({ where: { id: vehicleId }, data });
  } catch (err) {
    if (err?.code === "P2002") {
      throw httpError(409, "Another vehicle already uses that plate number");
    }
    throw err;
  }
}

// Only a vehicle that has never been used can be deleted. One with trips
// must be deactivated instead, or its trip history would be orphaned.
async function deleteVehicle(vehicleId) {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: { _count: { select: { tripRequests: true } } },
  });

  if (!vehicle) {
    throw httpError(404, "Vehicle not found");
  }

  if (vehicle._count.tripRequests > 0) {
    throw httpError(
      409,
      `${vehicle.model} (${vehicle.plateNumber}) has ${vehicle._count.tripRequests} trip(s) on record and cannot be deleted. Set it to Inactive instead.`
    );
  }

  await prisma.vehicle.delete({ where: { id: vehicleId } });
}
/// Replaces a vehicle's whole driver list in one call.
///
/// Idempotent by design: the caller sends the complete desired set and the
/// server makes reality match. That's easier to reason about than add/remove
/// calls, and it can't drift if a request is retried.
async function setVehicleDrivers(vehicleId, assignments) {
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) {
    const err = new Error("Vehicle not found.");
    err.status = 404;
    throw err;
  }

  const list = Array.isArray(assignments) ? assignments : [];

  // Drop duplicate driverIds — the unique constraint would reject them and
  // the admin almost certainly meant one row.
  const seen = new Set();
  const cleaned = [];
  for (const item of list) {
    const driverId = item?.driverId;
    if (!driverId || seen.has(driverId)) continue;
    seen.add(driverId);
    cleaned.push({ driverId, isPrimary: item.isPrimary === true });
  }

  if (cleaned.filter((a) => a.isPrimary).length > 1) {
    const err = new Error("Only one driver can be the primary for a vehicle.");
    err.status = 400;
    throw err;
  }

  if (cleaned.length > 0) {
    const validDrivers = await prisma.user.findMany({
      where: {
        id: { in: cleaned.map((a) => a.driverId) },
        role: { in: ["DRIVER", "HEAD_DRIVER"] },
        isActive: true,
        isApproved: true,
      },
      select: { id: true },
    });

    if (validDrivers.length !== cleaned.length) {
      const err = new Error(
        "One or more selected users are not approved, active drivers."
      );
      err.status = 400;
      throw err;
    }
  }

  // Replace the set atomically, so a failure can't leave the vehicle with
  // no drivers at all.
  await prisma.$transaction([
    prisma.vehicleAssignment.deleteMany({ where: { vehicleId } }),
    ...(cleaned.length === 0
      ? []
      : [
          prisma.vehicleAssignment.createMany({
            data: cleaned.map((a) => ({
              vehicleId,
              driverId: a.driverId,
              isPrimary: a.isPrimary,
            })),
          }),
        ]),
  ]);

  return listVehicleDrivers(vehicleId);
}

async function listVehicleDrivers(vehicleId) {
  const rows = await prisma.vehicleAssignment.findMany({
    where: { vehicleId },
    orderBy: [{ isPrimary: "desc" }, { assignedAt: "asc" }],
    select: {
      isPrimary: true,
      driver: {
        select: {
          id: true,
          fullName: true,
          avatarUrl: true,
          role: true,
          driverProfile: { select: { driverCode: true, status: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.driver.id,
    fullName: row.driver.fullName,
    avatarUrl: row.driver.avatarUrl,
    role: row.driver.role,
    driverCode: row.driver.driverProfile?.driverCode ?? null,
    status: row.driver.driverProfile?.status ?? "OFF_DUTY",
    isPrimary: row.isPrimary,
  }));
}




module.exports = {
  listPendingDrivers,
  approveDriver,
  rejectDriver,
  updateUserRole,
  listDrivers,
  setDriverStatus,
  listPendingTrips,
  listAllTrips,
  approveTrip,
  rejectTrip,
  setVehicleStatus,
  updateVehicle,
  deleteVehicle,
  setVehicleDrivers,
};