const prisma = require("../config/prisma");

// ------------------------------------------------------
// Which statuses reserve a driver / vehicle
// ------------------------------------------------------
// PENDING trips do NOT block: a request still waiting for Admin must never
// lock a driver for everyone else. REJECTED and COMPLETED never block.
const DRIVER_BLOCKING_STATUSES = [
  "ADMIN_APPROVED",
  "HEAD_DRIVER_APPROVED",
  "DRIVER_ACCEPTED",
  "ONGOING",
];

// The vehicle stays reserved even while the trip waits for a replacement
// driver, but the driver who declined is free again.
const VEHICLE_BLOCKING_STATUSES = [...DRIVER_BLOCKING_STATUSES, "DRIVER_DECLINED"];

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const TIME_ZONE = "Asia/Manila";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Only what computeBusyWindows needs.
const windowSelect = {
  id: true,
  ticketNumber: true,
  serviceMode: true,
  departureTime: true,
  returnTime: true,
  pickupTime: true,
  driverId: true,
  vehicleId: true,
  stops: { select: { travelMinutes: true } },
};

// ------------------------------------------------------
// Busy windows
// ------------------------------------------------------

// The farthest stop decides how long the driver is on the road.
function travelMinutesOf(stops) {
  return (stops || []).reduce((max, stop) => Math.max(max, stop.travelMinutes || 0), 0);
}

function endOfDay(date) {
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return end;
}

// Returns the periods during which the driver + vehicle are unavailable.
//
// WAIT:            one window, departure → return.
// DROP_AND_PICKUP: two windows —
//   1. drop-off: departure → back at base (departure + 2 x travel)
//   2. pick-up:  leaves base (pickup - travel) → home (pickup + travel)
//   The gap between them is free for other trips.
function computeBusyWindows(trip) {
  const departure = new Date(trip.departureTime);
  const travelMs = travelMinutesOf(trip.stops) * MS_PER_MINUTE;

  if (trip.serviceMode === "DROP_AND_PICKUP" && trip.pickupTime) {
    const pickup = new Date(trip.pickupTime);
    return [
      { start: departure, end: new Date(departure.getTime() + travelMs * 2) },
      { start: new Date(pickup.getTime() - travelMs), end: new Date(pickup.getTime() + travelMs) },
    ];
  }

  // WAIT mode. Trips created before returnTime was required fall back to
  // "booked until the end of that day" so they still block safely.
  const end = trip.returnTime ? new Date(trip.returnTime) : endOfDay(departure);
  return [{ start: departure, end }];
}

function windowsOverlap(a, b) {
  // Touching edges are fine: 8–12 and 12–3 do NOT overlap.
  return a.start < b.end && a.end > b.start;
}

function anyOverlap(windowsA, windowsB) {
  return windowsA.some((a) => windowsB.some((b) => windowsOverlap(a, b)));
}

// ------------------------------------------------------
// Conflict lookup
// ------------------------------------------------------

async function loadCandidateTrips(client, { windows, statuses, where }) {
  const earliest = new Date(Math.min(...windows.map((w) => w.start.getTime())) - MS_PER_DAY);
  const latest = new Date(Math.max(...windows.map((w) => w.end.getTime())) + MS_PER_DAY);

  return client.tripRequest.findMany({
    where: {
      ...where,
      status: { in: statuses },
      departureTime: { gte: earliest, lte: latest },
    },
    select: windowSelect,
  });
}

// Every already-booked trip of this driver that clashes with the windows.
async function findDriverConflicts(client, { driverId, windows, excludeTripId = null }) {
  const trips = await loadCandidateTrips(client, {
    windows,
    statuses: DRIVER_BLOCKING_STATUSES,
    where: {
      driverId,
      ...(excludeTripId ? { NOT: { id: excludeTripId } } : {}),
    },
  });

  return trips.filter((trip) => anyOverlap(windows, computeBusyWindows(trip)));
}

async function findVehicleConflicts(client, { vehicleId, windows, excludeTripId = null }) {
  const trips = await loadCandidateTrips(client, {
    windows,
    statuses: VEHICLE_BLOCKING_STATUSES,
    where: {
      vehicleId,
      ...(excludeTripId ? { NOT: { id: excludeTripId } } : {}),
    },
  });

  return trips.filter((trip) => anyOverlap(windows, computeBusyWindows(trip)));
}

// ------------------------------------------------------
// Messages
// ------------------------------------------------------

function formatTime(date) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function describeConflict(trip) {
  const windows = computeBusyWindows(trip);
  const parts = windows.map((w) => `${formatTime(w.start)} - ${formatTime(w.end)}`).join(" and ");
  return `${trip.ticketNumber} on ${formatDate(new Date(trip.departureTime))} (${parts})`;
}

// ------------------------------------------------------
// Public helpers
// ------------------------------------------------------

// Throws 409 if the driver or the vehicle is already taken.
// Pass the transaction client so the check and the write stay atomic.
async function assertAvailable(client, { driverId, vehicleId, windows, excludeTripId = null }) {
  const driverConflicts = await findDriverConflicts(client, { driverId, windows, excludeTripId });
  if (driverConflicts.length > 0) {
    throw httpError(
      409,
      `This driver is already booked for ${describeConflict(driverConflicts[0])}. Choose another driver or another time.`
    );
  }

  const vehicleConflicts = await findVehicleConflicts(client, { vehicleId, windows, excludeTripId });
  if (vehicleConflicts.length > 0) {
    throw httpError(
      409,
      `This vehicle is already booked for ${describeConflict(vehicleConflicts[0])}. Choose another vehicle or another time.`
    );
  }
}

// Ids to hide from the "available drivers" / "available vehicles" dropdowns
// for the time range the requester picked.
async function findBusyDriverIds(client, { windows, excludeTripId = null }) {
  const trips = await loadCandidateTrips(client, {
    windows,
    statuses: DRIVER_BLOCKING_STATUSES,
    where: excludeTripId ? { NOT: { id: excludeTripId } } : {},
  });

  return new Set(
    trips.filter((t) => anyOverlap(windows, computeBusyWindows(t))).map((t) => t.driverId)
  );
}

async function findBusyVehicleIds(client, { windows, excludeTripId = null }) {
  const trips = await loadCandidateTrips(client, {
    windows,
    statuses: VEHICLE_BLOCKING_STATUSES,
    where: excludeTripId ? { NOT: { id: excludeTripId } } : {},
  });

  return new Set(
    trips.filter((t) => anyOverlap(windows, computeBusyWindows(t))).map((t) => t.vehicleId)
  );
}

// Windows for a trip that has not been saved yet.
function buildWindows({ serviceMode, departureTime, returnTime, pickupTime, travelMinutes }) {
  return computeBusyWindows({
    serviceMode,
    departureTime,
    returnTime,
    pickupTime,
    stops: [{ travelMinutes: travelMinutes || 0 }],
  });
}

module.exports = {
  prisma, // convenience for callers that are not inside a transaction
  DRIVER_BLOCKING_STATUSES,
  VEHICLE_BLOCKING_STATUSES,
  computeBusyWindows,
  buildWindows,
  windowsOverlap,
  anyOverlap,
  findDriverConflicts,
  findVehicleConflicts,
  assertAvailable,
  findBusyDriverIds,
  findBusyVehicleIds,
  describeConflict,
};