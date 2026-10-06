const prisma = require("../config/prisma");

const TIME_ZONE = "Asia/Manila";
const ACTIVE_STATUSES = [
  "PENDING",
  "ADMIN_APPROVED",
  "HEAD_DRIVER_APPROVED",
  "DRIVER_ACCEPTED",
  "DRIVER_DECLINED",
  "ONGOING",
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Start and end of "today" in Manila, expressed as UTC instants, so the
// dashboard matches what staff see on a wall clock.
function todayRange() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  const start = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function monthKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).format(date); // "2026-09"
}

function monthLabel(key) {
  const [year, month] = key.split("-");
  return new Intl.DateTimeFormat("en-PH", { month: "short", year: "2-digit" })
    .format(new Date(Number(year), Number(month) - 1, 1));
}

// ------------------------------------------------------
// Dashboard
// ------------------------------------------------------

async function getDashboard() {
  const { start, end } = todayRange();

  const [
    todayTotal,
    pendingToday,
    ongoingNow,
    totalTrips,
    completedTrips,
    rejectedTrips,
    activeVehicles,
    totalVehicles,
    approvedDrivers,
    pendingDrivers,
    departmentGroups,
    departments,
    ratingAgg,
  ] = await Promise.all([
    prisma.tripRequest.count({ where: { date: { gte: start, lt: end } } }),
    prisma.tripRequest.count({
      where: { date: { gte: start, lt: end }, status: "PENDING" },
    }),
    prisma.tripRequest.count({ where: { status: "ONGOING" } }),
    prisma.tripRequest.count(),
    prisma.tripRequest.count({ where: { status: "COMPLETED" } }),
    prisma.tripRequest.count({ where: { status: "REJECTED" } }),
    prisma.vehicle.count({ where: { status: "ACTIVE" } }),
    prisma.vehicle.count(),
    prisma.user.count({
      where: { role: { in: ["DRIVER", "HEAD_DRIVER"] }, isApproved: true },
    }),
    prisma.user.count({ where: { role: "DRIVER", isApproved: false } }),
    prisma.tripRequest.groupBy({
      by: ["departmentId"],
      _count: { _all: true },
    }),
    prisma.department.findMany({ select: { id: true, name: true, code: true } }),
    prisma.rating.aggregate({ _avg: { score: true }, _count: { _all: true } }),
  ]);

  const departmentById = new Map(departments.map((d) => [d.id, d]));
  const departmentTrips = departmentGroups
    .map((row) => {
      const department = departmentById.get(row.departmentId);
      return {
        departmentId: row.departmentId,
        code: department?.code ?? "—",
        name: department?.name ?? "Unknown",
        tripCount: row._count._all,
      };
    })
    .sort((a, b) => b.tripCount - a.tripCount);

  // Trips still moving through the system, whatever day they are for.
  const inProgress = await prisma.tripRequest.count({
    where: { status: { in: ACTIVE_STATUSES } },
  });

  return {
    overview: {
      todayTotal,
      pendingToday,
      ongoingNow,
      inProgress,
    },
    cards: {
      totalTrips,
      completedTrips,
      rejectedTrips,
      activeVehicles,
      totalVehicles,
      approvedDrivers,
      pendingDrivers,
      averageRating: ratingAgg._avg.score,
      ratingCount: ratingAgg._count._all,
    },
    departmentTrips,
  };
}

// ------------------------------------------------------
// Analysis
// ------------------------------------------------------

// Buckets are built in JS rather than SQL: a campus fleet's trip volume is
// small, and this keeps the query portable.
async function getAnalytics({ months } = {}) {
  const monthSpan = Math.min(Math.max(Number(months) || 6, 1), 24);

  const since = new Date();
  since.setMonth(since.getMonth() - (monthSpan - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const [trips, statusGroups, destinationStops, completed] = await Promise.all([
    prisma.tripRequest.findMany({
      where: { date: { gte: since } },
      select: {
        date: true,
        status: true,
        isUrgent: true,
        requester: { select: { role: true } },
      },
    }),
    prisma.tripRequest.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.tripStop.findMany({
      where: { type: "DESTINATION" },
      select: { address: true, location: { select: { name: true } } },
    }),
    prisma.tripRequest.findMany({
      where: { status: "COMPLETED" },
      select: {
        driverId: true,
        vehicleId: true,
        driver: { select: { fullName: true } },
        vehicle: { select: { model: true, plateNumber: true } },
        arrival: {
          select: { distanceTraveledKm: true, gasolineUsedLiters: true },
        },
      },
    }),
  ]);

  // ----- trips per month, split by who requested them -----
  // FACULTY covers "Visiting Lecturer" too — they are the same role, so the
  // chart shows three requester types, not four.
  const emptyMonth = () => ({
    total: 0,
    completed: 0,
    urgent: 0,
    faculty: 0,
    staff: 0,
    ssg: 0,
  });

  const byMonth = new Map();
  for (let i = 0; i < monthSpan; i++) {
    const d = new Date(since);
    d.setMonth(since.getMonth() + i);
    byMonth.set(monthKey(d), emptyMonth());
  }
  for (const trip of trips) {
    const bucket = byMonth.get(monthKey(trip.date));
    if (!bucket) continue;
    bucket.total += 1;
    if (trip.status === "COMPLETED") bucket.completed += 1;
    if (trip.isUrgent) bucket.urgent += 1;

    switch (trip.requester?.role) {
      case "FACULTY":
        bucket.faculty += 1;
        break;
      case "STAFF":
        bucket.staff += 1;
        break;
      case "SSG_PRESIDENT":
        bucket.ssg += 1;
        break;
      default:
        break;
    }
  }
  const tripsByMonth = [...byMonth.entries()].map(([key, value]) => ({
    month: key,
    label: monthLabel(key),
    ...value,
  }));

  // ----- trips by status -----
  const tripsByStatus = statusGroups
    .map((row) => ({ status: row.status, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  // ----- most visited destinations -----
  const destinationCounts = new Map();
  for (const stop of destinationStops) {
    const name = stop.location?.name ?? stop.address;
    destinationCounts.set(name, (destinationCounts.get(name) ?? 0) + 1);
  }
  const topDestinations = [...destinationCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // ----- per driver and per vehicle, from completed trips -----
  const driverStats = new Map();
  const vehicleStats = new Map();
  let totalDistance = 0;
  let totalFuel = 0;

  for (const trip of completed) {
    const km = trip.arrival?.distanceTraveledKm ?? 0;
    const fuel = trip.arrival?.gasolineUsedLiters ?? 0;
    totalDistance += km;
    totalFuel += fuel;

    const driver = driverStats.get(trip.driverId) ?? {
      id: trip.driverId,
      name: trip.driver?.fullName ?? "—",
      trips: 0,
      distanceKm: 0,
    };
    driver.trips += 1;
    driver.distanceKm += km;
    driverStats.set(trip.driverId, driver);

    const vehicle = vehicleStats.get(trip.vehicleId) ?? {
      id: trip.vehicleId,
      label: trip.vehicle
        ? `${trip.vehicle.model} (${trip.vehicle.plateNumber})`
        : "—",
      trips: 0,
      distanceKm: 0,
      fuelLiters: 0,
    };
    vehicle.trips += 1;
    vehicle.distanceKm += km;
    vehicle.fuelLiters += fuel;
    vehicleStats.set(trip.vehicleId, vehicle);
  }

  // Ratings are averaged separately so drivers with no completed trips in
  // this window still show their standing.
  const ratings = await prisma.rating.groupBy({
    by: ["ratedUserId"],
    _avg: { score: true },
    _count: { _all: true },
  });
  const ratingByDriver = new Map(
    ratings.map((r) => [r.ratedUserId, { avg: r._avg.score, count: r._count._all }])
  );

  const driverPerformance = [...driverStats.values()]
    .map((d) => ({
      ...d,
      distanceKm: Math.round(d.distanceKm),
      averageRating: ratingByDriver.get(d.id)?.avg ?? null,
      ratingCount: ratingByDriver.get(d.id)?.count ?? 0,
    }))
    .sort((a, b) => b.trips - a.trips);

  const vehicleUsage = [...vehicleStats.values()]
    .map((v) => ({
      ...v,
      distanceKm: Math.round(v.distanceKm),
      fuelLiters: Math.round(v.fuelLiters * 100) / 100,
      // Rough efficiency, only meaningful once a vehicle has real trips.
      kmPerLiter: v.fuelLiters > 0 ? Math.round((v.distanceKm / v.fuelLiters) * 10) / 10 : null,
    }))
    .sort((a, b) => b.trips - a.trips);

  return {
    monthSpan,
    tripsByMonth,
    tripsByStatus,
    topDestinations,
    driverPerformance,
    vehicleUsage,
    totals: {
      completedTrips: completed.length,
      distanceKm: Math.round(totalDistance),
      fuelLiters: Math.round(totalFuel * 100) / 100,
    },
  };
}

module.exports = { getDashboard, getAnalytics };