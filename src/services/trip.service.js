const prisma = require("../config/prisma");
const storageService = require("./storage.service");
const availability = require("./availability.service");
const settingsService = require("./settings.service");

const SERVICE_MODES = ["WAIT", "DROP_AND_PICKUP"];
const DRIVER_ROLES = ["DRIVER", "HEAD_DRIVER"]; // the Head Driver also drives
const BOOKABLE_VEHICLE_STATUSES = ["ACTIVE", "ON_TRIP"]; // ON_TRIP now may still be free later
const MIN_TRAVEL_MINUTES = 1;
const MAX_TRAVEL_MINUTES = 24 * 60;
const MAX_TICKET_RETRIES = 3;
const ON_TIME_GRACE_MINUTES = 15;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ------------------------------------------------------
// Parsing helpers
// ------------------------------------------------------

function parseDateTime(value, field) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw httpError(400, `${field} is not a valid date/time`);
  }
  return date;
}

function parseTravelMinutes(value, field) {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(num) || num < MIN_TRAVEL_MINUTES || num > MAX_TRAVEL_MINUTES) {
    throw httpError(
      400,
      `${field} must be a whole number of minutes from ${MIN_TRAVEL_MINUTES} to ${MAX_TRAVEL_MINUTES}`
    );
  }
  return num;
}

// Uses the HIGHEST existing number, not count + 1, so numbers never repeat.
async function generateTicketNumber(client) {
  const year = new Date().getFullYear();
  const prefix = `TT-${year}-`;

  const rows = await client.tripRequest.findMany({
    where: { ticketNumber: { startsWith: prefix } },
    select: { ticketNumber: true },
  });

  const highest = rows.reduce((max, { ticketNumber }) => {
    const num = parseInt(ticketNumber.slice(prefix.length), 10);
    return Number.isNaN(num) ? max : Math.max(max, num);
  }, 0);

  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

// ------------------------------------------------------
// Validation of the request pieces
// ------------------------------------------------------

// The Upload step rule: an authorization letter, OR urgent with a reason.
function validateLetterOrUrgent({ hasLetter, manualUrgent, urgentReason }) {
  if (!hasLetter && !manualUrgent) {
    throw httpError(
      400,
      "Upload an authorization letter, or mark the trip as urgent and give a reason."
    );
  }
  if (manualUrgent && !String(urgentReason || "").trim()) {
    throw httpError(400, "urgentReason is required when the trip is marked urgent");
  }
}

// WAIT needs a return time. DROP_AND_PICKUP needs a pick-up time.
function validateSchedule({ serviceMode, departureTime, returnTime, pickupTime }) {
  if (!SERVICE_MODES.includes(serviceMode)) {
    throw httpError(400, `serviceMode must be one of: ${SERVICE_MODES.join(", ")}`);
  }

  const departure = parseDateTime(departureTime, "departureTime");

  if (serviceMode === "WAIT") {
    const end = parseDateTime(returnTime, "returnTime");
    if (end <= departure) {
      throw httpError(400, "returnTime must be after departureTime");
    }
    return { departure, end, pickup: null };
  }

  const pickup = parseDateTime(pickupTime, "pickupTime");
  if (pickup <= departure) {
    throw httpError(400, "pickupTime must be after departureTime");
  }
  return { departure, end: null, pickup };
}

// Resolves every stop against the Location list, and copies the travel time
// into the stop so later edits to a Location never change approved trips.
async function resolveStops(client, stops) {
  if (!Array.isArray(stops) || stops.length < 2) {
    throw httpError(400, "At least an origin and a destination stop are required");
  }

  const origins = stops.filter((s) => s.type === "ORIGIN");
  const destinations = stops.filter((s) => s.type === "DESTINATION");
  if (origins.length !== 1 || destinations.length !== 1) {
    throw httpError(400, "Provide exactly one ORIGIN stop and one DESTINATION stop");
  }

  const locationIds = [...new Set(stops.map((s) => s.locationId).filter(Boolean))];
  const locations = locationIds.length
    ? await client.location.findMany({ where: { id: { in: locationIds } } })
    : [];
  const byId = new Map(locations.map((l) => [l.id, l]));

  for (const id of locationIds) {
    const found = byId.get(id);
    if (!found) throw httpError(400, "One of the selected locations no longer exists");
    if (!found.isActive) {
      throw httpError(400, `The location "${found.name}" is no longer available`);
    }
  }

  return stops.map((stop, index) => {
    const address = String(stop.address || "").trim();
    const order = Number.isInteger(stop.order) ? stop.order : index;

    // The origin is always base (Katipunan) — no travel time of its own.
    if (stop.type === "ORIGIN") {
      if (!address) throw httpError(400, "The origin address is required");
      return { type: "ORIGIN", address, order, locationId: null, travelMinutes: 0 };
    }

    if (stop.locationId) {
      const location = byId.get(stop.locationId);
      return {
        type: stop.type,
        address: address || location.name,
        order,
        locationId: location.id,
        travelMinutes: location.travelMinutes,
      };
    }

    // "Other": a place not on the Admin list — the requester typed an estimate.
    if (!address) throw httpError(400, "Each stop needs a location or a typed address");
    return {
      type: stop.type,
      address,
      order,
      locationId: null,
      travelMinutes: parseTravelMinutes(stop.travelMinutes, `travelMinutes for "${address}"`),
    };
  });
}

// Clear messages instead of raw foreign-key errors.
async function validateReferences(client, { departmentId, driverId, vehicleId }) {
  const [department, driver, vehicle] = await Promise.all([
    client.department.findUnique({ where: { id: departmentId } }),
    client.user.findUnique({ where: { id: driverId }, include: { driverProfile: true } }),
    client.vehicle.findUnique({ where: { id: vehicleId } }),
  ]);

  if (!department) throw httpError(400, "Selected department was not found");

  if (!driver || !DRIVER_ROLES.includes(driver.role)) {
    throw httpError(400, "Selected driver was not found");
  }
  if (!driver.isApproved || !driver.isActive) {
    throw httpError(400, "Selected driver is not available for booking");
  }
  if (driver.driverProfile?.status === "OFF_DUTY") {
    throw httpError(400, "Selected driver is off duty");
  }

  if (!vehicle) throw httpError(400, "Selected vehicle was not found");
  if (!BOOKABLE_VEHICLE_STATUSES.includes(vehicle.status)) {
    throw httpError(400, `Selected vehicle is currently ${vehicle.status.toLowerCase()}`);
  }
}

// ------------------------------------------------------
// Create
// ------------------------------------------------------

const tripInclude = {
  passengers: true,
  stops: { orderBy: { order: "asc" }, include: { location: true } },
  department: true,
  requester: { select: { id: true, fullName: true, email: true, phone: true } },
  driver: { select: { id: true, fullName: true, email: true, phone: true, role: true } },
  vehicle: {
    select: { id: true, model: true, plateNumber: true, type: true, odometerCurrent: true },
  },
  departure: true,
  arrival: true,
  rating: true,
  adminApprovedBy: { select: { id: true, fullName: true } },
  headDriverApprovedBy: { select: { id: true, fullName: true } },
};

async function createTripRequest({
  requesterId,
  departmentId,
  purpose,
  date,
  departureTime,
  serviceMode,
  returnTime, // required in WAIT mode
  pickupTime, // required in DROP_AND_PICKUP mode
  driverId,
  vehicleId,
  passengerNames, // array of strings
  stops, // array of { type, address, order, locationId?, travelMinutes? }
  certifyOfficialBusiness,
  certifyRecordCorrectness,
  manualUrgent,
  urgentReason,
  authorizationLetterFile, // { buffer, originalname } or null
}) {
  if (!String(purpose || "").trim()) {
    throw httpError(400, "purpose is required");
  }

  validateLetterOrUrgent({
    hasLetter: !!authorizationLetterFile,
    manualUrgent,
    urgentReason,
  });

  const { departure, end, pickup } = validateSchedule({
    serviceMode,
    departureTime,
    returnTime,
    pickupTime,
  });

  const tripDate = parseDateTime(date, "date");
  const resolvedStops = await resolveStops(prisma, stops);
  await validateReferences(prisma, { departmentId, driverId, vehicleId });

  const travelMinutes = resolvedStops.reduce((max, s) => Math.max(max, s.travelMinutes), 0);
  const windows = availability.buildWindows({
    serviceMode,
    departureTime: departure,
    returnTime: end,
    pickupTime: pickup,
    travelMinutes,
  });

  // Saved only after every check passes, so a rejected request leaves no file.
  let authorizationLetterUrl = null;
  if (authorizationLetterFile) {
    authorizationLetterUrl = await storageService.saveFile(
      authorizationLetterFile.buffer,
      authorizationLetterFile.originalname,
      "authorization-letters"
    );
  }

  const isUrgent = !!manualUrgent;

  for (let attempt = 1; attempt <= MAX_TICKET_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Re-checked inside the transaction so two requests submitted at the
        // same moment cannot both take the same driver or vehicle.
        await availability.assertAvailable(tx, { driverId, vehicleId, windows });

        const ticketNumber = await generateTicketNumber(tx);

        return tx.tripRequest.create({
          data: {
            ticketNumber,
            requesterId,
            departmentId,
            purpose: String(purpose).trim(),
            date: tripDate,
            departureTime: departure,
            serviceMode,
            returnTime: end,
            pickupTime: pickup,
            driverId,
            vehicleId,
            authorizationLetterUrl,
            certifyOfficialBusiness: !!certifyOfficialBusiness,
            certifyStatementCorrect: !!certifyRecordCorrectness,
            isUrgent,
            urgentReason: isUrgent ? String(urgentReason).trim() : null,
            status: "PENDING",
            passengers: {
              create: (passengerNames || [])
                .map((name) => String(name).trim())
                .filter(Boolean)
                .map((name) => ({ name })),
            },
            stops: { create: resolvedStops },
          },
          include: tripInclude,
        });
      });
    } catch (err) {
      const duplicateTicket =
        err?.code === "P2002" &&
        String(err.meta?.target || "").includes("ticketNumber");

      if (duplicateTicket && attempt < MAX_TICKET_RETRIES) continue;
      throw err;
    }
  }
}

// ------------------------------------------------------
// Reads
// ------------------------------------------------------

async function listMyTrips(requesterId) {
  return prisma.tripRequest.findMany({
    where: { requesterId },
    orderBy: { createdAt: "desc" },
    include: tripInclude,
  });
}

async function listDepartments() {
  return prisma.department.findMany({ orderBy: { name: "asc" } });
}

// Destinations the requester can pick, with their travel time from base.
async function listLocations() {
  return prisma.location.findMany({
    where: { isActive: true },
    select: { id: true, name: true, travelMinutes: true },
    orderBy: { name: "asc" },
  });
}

// Windows are optional: with no schedule given, every eligible driver/vehicle
// is returned. Once the requester has picked a time, the ones already booked
// for that time are filtered out.
function windowsFromQuery({ serviceMode, departureTime, returnTime, pickupTime, travelMinutes }) {
  if (!departureTime || !serviceMode) return null;

  try {
    const { departure, end, pickup } = validateSchedule({
      serviceMode,
      departureTime,
      returnTime,
      pickupTime,
    });

    const minutes = travelMinutes ? Number(travelMinutes) : 0;

    return availability.buildWindows({
      serviceMode,
      departureTime: departure,
      returnTime: end,
      pickupTime: pickup,
      travelMinutes: Number.isFinite(minutes) ? minutes : 0,
    });
  } catch (err) {
    // An incomplete schedule just means "don't filter yet".
    return null;
  }
}

async function listAvailableDrivers(query = {}) {
  const drivers = await prisma.user.findMany({
    where: {
      role: { in: DRIVER_ROLES },
      isApproved: true,
      isActive: true,
      // OFF_DUTY is set by Admin and means "not working at all".
      // ON_TRIP is NOT excluded: a driver busy today can still be booked
      // for next week — the overlap check below decides.
      driverProfile: { status: { not: "OFF_DUTY" } },
    },
    select: { id: true, fullName: true, email: true, role: true },
    orderBy: { fullName: "asc" },
  });

  const windows = windowsFromQuery(query);
  if (!windows) return drivers;

  const busy = await availability.findBusyDriverIds(prisma, { windows });
  return drivers.filter((d) => !busy.has(d.id));
}

async function listAvailableVehicles(query = {}) {
  const vehicles = await prisma.vehicle.findMany({
    where: { status: { in: BOOKABLE_VEHICLE_STATUSES } },
    orderBy: { model: "asc" },
  });

  const windows = windowsFromQuery(query);
  if (!windows) return vehicles;

  const busy = await availability.findBusyVehicleIds(prisma, { windows });
  return vehicles.filter((v) => !busy.has(v.id));
}

async function listDriverDirectory() {
  const drivers = await prisma.user.findMany({
    where: {
      role: { in: ["DRIVER", "HEAD_DRIVER"] },
      // Deactivated or not-yet-approved drivers can't be booked, so showing
      // them here would only mislead the requester.
      isActive: true,
      isApproved: true,
    },
    select: {
      id: true,
      fullName: true,
      avatarUrl: true,
      role: true,
      driverProfile: {
        select: { driverCode: true, status: true },
      },
    },
    orderBy: { fullName: "asc" },
  });

  if (drivers.length === 0) return [];

  const driverIds = drivers.map((d) => d.id);

  const [tripCounts, ratingAggregates] = await Promise.all([
    prisma.tripRequest.groupBy({
      by: ["driverId"],
      where: { driverId: { in: driverIds }, status: "COMPLETED" },
      _count: { _all: true },
    }),
    // There is no stored average on DriverProfile, so it's computed from
    // the ratings table. @@index([ratedUserId]) makes this cheap.
    prisma.rating.groupBy({
      by: ["ratedUserId"],
      where: { ratedUserId: { in: driverIds } },
      _avg: { score: true },
      _count: { _all: true },
    }),
  ]);

  const tripsByDriver = new Map(
    tripCounts.map((row) => [row.driverId, row._count._all])
  );
  const ratingByDriver = new Map(
    ratingAggregates.map((row) => [row.ratedUserId, row])
  );

  return drivers.map((driver) => {
    const rating = ratingByDriver.get(driver.id);
    return {
      id: driver.id,
      fullName: driver.fullName,
      avatarUrl: driver.avatarUrl,
      role: driver.role,
      driverCode: driver.driverProfile?.driverCode ?? null,
      // A driver row with no profile shouldn't read as "AVAILABLE" —
      // that would invite a booking that the availability check rejects.
      status: driver.driverProfile?.status ?? "OFF_DUTY",
      completedTrips: tripsByDriver.get(driver.id) ?? 0,
      averageRating: rating?._avg.score ?? null,
      ratingCount: rating?._count._all ?? 0,
    };
  });
}

/// The fleet as a requester should see it.
///
/// INACTIVE (retired) vehicles are hidden; MAINTENANCE ones are kept so the
/// requester understands why the fleet looks smaller than usual today.
async function listVehicleDirectory() {
  return prisma.vehicle.findMany({
    where: { status: { not: "INACTIVE" } },
    select: {
      id: true,
      model: true,
      plateNumber: true,
      type: true,
      capacity: true,
      year: true,
      fuelType: true,
      imageUrl: true,
      status: true,
    },
    orderBy: [{ status: "asc" }, { model: "asc" }],
  });
}



// ------------------------------------------------------
// One trip, and rating it afterwards
// ------------------------------------------------------

// The requester, the assigned driver, the admin and the head driver may
// open a trip. Anyone else gets a 404 rather than a 403, so trip ids
// cannot be probed.
function assertCanView(user, trip) {
  const allowed =
    trip.requesterId === user.sub ||
    trip.driverId === user.sub ||
    user.role === "ADMIN" ||
    user.role === "HEAD_DRIVER";

  if (!allowed) {
    throw httpError(404, "Trip not found");
  }
}

async function getTripForUser(user, tripId) {
  const trip = await prisma.tripRequest.findUnique({
    where: { id: tripId },
    include: tripInclude,
  });

  if (!trip) {
    throw httpError(404, "Trip not found");
  }
  assertCanView(user, trip);
  return trip;
}

// A trip counts as on time if it left within this many minutes of the
// scheduled departure. Campus trips wait for passengers, so a hard
// zero-minute rule would score every driver near 0%.

/// Everything the requester's driver detail screen shows.
///
/// Home address is deliberately NOT returned. Phone and email are, so a
/// requester can reach the driver about a trip.
async function getDriverDetail(driverId) {
  const driver = await prisma.user.findFirst({
    where: {
      id: driverId,
      role: { in: ["DRIVER", "HEAD_DRIVER"] },
      isActive: true,
      isApproved: true,
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      phone: true,
      avatarUrl: true,
      role: true,
      driverProfile: {
        select: {
          driverCode: true,
          employeeId: true,
          status: true,
          dateHired: true,
          incidentCount: true,
        },
      },
      vehicleAssignments: {
        orderBy: [{ isPrimary: "desc" }, { assignedAt: "asc" }],
        select: {
          isPrimary: true,
          vehicle: {
            select: {
              id: true,
              model: true,
              plateNumber: true,
              type: true,
              imageUrl: true,
              status: true,
            },
          },
        },
      },
    },
  });

  // Same 404 whether the id is unknown or the driver is deactivated — a
  // requester has no business distinguishing those.
  if (!driver) {
    const err = new Error("Driver not found.");
    err.status = 404;
    throw err;
  }

  const [trips, ratingAggregate] = await Promise.all([
    // One query serves three of the four stat columns: trip count,
    // kilometres driven and the on-time percentage.
    prisma.tripRequest.findMany({
      where: { driverId, status: "COMPLETED" },
      select: {
        departureTime: true,                              // scheduled
        departure: { select: { departureTime: true } },   // actual
        arrival: { select: { distanceTraveledKm: true } },
      },
    }),
    prisma.rating.aggregate({
      where: { ratedUserId: driverId },
      _avg: { score: true },
      _count: { _all: true },
    }),
  ]);

  let kilometresDriven = 0;
  let departuresRecorded = 0;
  let onTimeDepartures = 0;

  for (const trip of trips) {
    kilometresDriven += trip.arrival?.distanceTraveledKm ?? 0;

    if (trip.departure) {
      departuresRecorded += 1;
      const scheduled = new Date(trip.departureTime).getTime();
      const actual = new Date(trip.departure.departureTime).getTime();
      if (actual - scheduled <= ON_TIME_GRACE_MINUTES * 60 * 1000) {
        onTimeDepartures += 1;
      }
    }
  }

  return {
    id: driver.id,
    fullName: driver.fullName,
    email: driver.email,
    phone: driver.phone,
    avatarUrl: driver.avatarUrl,
    role: driver.role,

    driverCode: driver.driverProfile?.driverCode ?? null,
    employeeId: driver.driverProfile?.employeeId ?? null,
    status: driver.driverProfile?.status ?? "OFF_DUTY",
    dateHired: driver.driverProfile?.dateHired ?? null,

    completedTrips: trips.length,
    // One decimal; the odometer readings don't justify more.
    kilometresDriven: Math.round(kilometresDriven * 10) / 10,
    incidentCount: driver.driverProfile?.incidentCount ?? 0,

    // Null, not 0, when no departure has ever been recorded — "0% on time"
    // would be a lie about a driver who simply has no history yet.
    onTimePercentage:
      departuresRecorded === 0
        ? null
        : Math.round((onTimeDepartures / departuresRecorded) * 100),

    averageRating: ratingAggregate._avg.score ?? null,
    ratingCount: ratingAggregate._count._all ?? 0,

    assignedVehicles: driver.vehicleAssignments.map((a) => ({
      id: a.vehicle.id,
      model: a.vehicle.model,
      plateNumber: a.vehicle.plateNumber,
      type: a.vehicle.type,
      imageUrl: a.vehicle.imageUrl,
      status: a.vehicle.status,
      isPrimary: a.isPrimary,
    })),
  };
}

// The requester rates the driver once, after the trip is completed.
// comment is their written feedback.
async function rateTrip(requesterId, tripId, { score, comment }) {
  const parsedScore = typeof score === "string" ? Number(score.trim()) : score;
  if (!Number.isInteger(parsedScore) || parsedScore < 1 || parsedScore > 5) {
    throw httpError(400, "score must be a whole number from 1 to 5");
  }

  return prisma.$transaction(async (tx) => {
    const trip = await tx.tripRequest.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        ticketNumber: true,
        requesterId: true,
        driverId: true,
        status: true,
        rating: { select: { id: true } },
      },
    });

    if (!trip || trip.requesterId !== requesterId) {
      throw httpError(404, "Trip not found");
    }
    if (trip.status !== "COMPLETED") {
      throw httpError(400, "You can rate the driver once the trip is completed");
    }
    if (trip.rating) {
      throw httpError(409, "You already rated this trip");
    }

    const cleanComment = String(comment || "").trim() || null;

    const rating = await tx.rating.create({
      data: {
        tripRequestId: tripId,
        raterId: requesterId,
        ratedUserId: trip.driverId,
        score: parsedScore,
        comment: cleanComment,
      },
    });

    await tx.notification.create({
      data: {
        userId: trip.driverId,
        title: "New Rating Received",
        message: cleanComment
          ? `You received ${parsedScore} of 5 for trip ${trip.ticketNumber}: ${cleanComment}`
          : `You received ${parsedScore} of 5 for trip ${trip.ticketNumber}.`,
      },
    });

    return rating;
  });
}


// The requester, the assigned driver and the admin may print a completed
// ticket. printedAt keeps the FIRST print only and is never overwritten.
async function markPrinted(user, tripId) {
  const trip = await prisma.tripRequest.findUnique({
    where: { id: tripId },
    include: tripInclude,
  });

  if (!trip) {
    throw httpError(404, "Trip not found");
  }

  const allowed =
    trip.requesterId === user.sub || trip.driverId === user.sub || user.role === "ADMIN";
  if (!allowed) {
    throw httpError(404, "Trip not found");
  }

  if (trip.status !== "COMPLETED") {
    throw httpError(400, "Only completed trips can be printed");
  }

  // The approver line on the printed ticket comes from the admin-editable
  // settings, so every role gets it with the same call.
  const settings = await settingsService.getSettings();

  if (trip.printedAt) return { trip, settings };

  const updated = await prisma.tripRequest.update({
    where: { id: tripId },
    data: { printedAt: new Date() },
    include: tripInclude,
  });

  return { trip: updated, settings };
}
// A trip counts as on time if it left within this many minutes of the
// scheduled departure. Campus trips wait for passengers, so a hard
// zero-minute rule would score every driver near 0%.


/// Everything the requester's driver detail screen shows.
///
/// Home address is deliberately NOT returned. Phone and email are, so a
/// requester can reach the driver about a trip.



module.exports = {
  createTripRequest,
  markPrinted,
  getTripForUser,
  getDriverDetail,
  rateTrip,
  listMyTrips,
  listDepartments,
  listLocations,
  listAvailableDrivers,
  listAvailableVehicles,
  listDriverDirectory,
  listVehicleDirectory,
};