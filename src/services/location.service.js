const prisma = require("../config/prisma");

const MAX_NAME_LENGTH = 100;
const MIN_TRAVEL_MINUTES = 1;
const MAX_TRAVEL_MINUTES = 24 * 60; // 1440 minutes = 24 hours

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ------------------------------------------------------
// Input validation
// ------------------------------------------------------

function parseName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw httpError(400, "name is required");
  }
  const clean = name.trim().replace(/\s+/g, " "); // collapse extra spaces
  if (clean.length > MAX_NAME_LENGTH) {
    throw httpError(400, `name must be ${MAX_NAME_LENGTH} characters or less`);
  }
  return clean;
}

function parseTravelMinutes(value) {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (!Number.isInteger(num) || num < MIN_TRAVEL_MINUTES || num > MAX_TRAVEL_MINUTES) {
    throw httpError(
      400,
      `travelMinutes must be a whole number from ${MIN_TRAVEL_MINUTES} to ${MAX_TRAVEL_MINUTES}`
    );
  }
  return num;
}

function parseIsActive(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw httpError(400, "isActive must be true or false");
}

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

// Stop count is computed by Prisma, never stored.
const includeUsage = { _count: { select: { stops: true } } };

function formatLocation(location) {
  const { _count, ...rest } = location;
  return { ...rest, usedInStops: _count?.stops ?? 0 };
}

// Blocks "dapitan" when "Dapitan" already exists (the DB unique
// constraint alone is case-sensitive).
async function ensureNameAvailable(name, excludeId = null) {
  const duplicate = await prisma.location.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw httpError(409, `A location named "${name}" already exists`);
  }
}

async function findLocationOrThrow(id) {
  const location = await prisma.location.findUnique({
    where: { id },
    include: includeUsage,
  });
  if (!location) {
    throw httpError(404, "Location not found");
  }
  return location;
}

// Two admins saving the same name at the same moment.
function rethrowUniqueName(err, name) {
  if (err?.code === "P2002") {
    throw httpError(409, `A location named "${name}" already exists`);
  }
  throw err;
}

// ------------------------------------------------------
// Service functions
// ------------------------------------------------------

async function listLocations({ status } = {}) {
  let where = {};
  if (status === "active") where = { isActive: true };
  else if (status === "inactive") where = { isActive: false };
  else if (status !== undefined && status !== "") {
    throw httpError(400, "status must be 'active' or 'inactive'");
  }

  const locations = await prisma.location.findMany({
    where,
    include: includeUsage,
    orderBy: { name: "asc" },
  });

  return locations.map(formatLocation);
}

async function getLocation(id) {
  const location = await findLocationOrThrow(id);
  return formatLocation(location);
}

async function createLocation({ name, travelMinutes }) {
  const cleanName = parseName(name);
  const cleanMinutes = parseTravelMinutes(travelMinutes);

  await ensureNameAvailable(cleanName);

  try {
    const location = await prisma.location.create({
      data: { name: cleanName, travelMinutes: cleanMinutes },
      include: includeUsage,
    });
    return formatLocation(location);
  } catch (err) {
    rethrowUniqueName(err, cleanName);
  }
}

async function updateLocation(id, { name, travelMinutes, isActive }) {
  await findLocationOrThrow(id);

  const data = {};
  if (name !== undefined) {
    data.name = parseName(name);
    await ensureNameAvailable(data.name, id);
  }
  if (travelMinutes !== undefined) data.travelMinutes = parseTravelMinutes(travelMinutes);
  if (isActive !== undefined) data.isActive = parseIsActive(isActive);

  if (Object.keys(data).length === 0) {
    throw httpError(400, "Provide at least one of: name, travelMinutes, isActive");
  }

  try {
    const location = await prisma.location.update({
      where: { id },
      data,
      include: includeUsage,
    });
    return formatLocation(location);
  } catch (err) {
    rethrowUniqueName(err, data.name);
  }
}

// Only locations never used by any trip can be deleted.
// Used locations must be deactivated instead, so trip history stays intact.
async function deleteLocation(id) {
  const location = await findLocationOrThrow(id);

  if (location._count.stops > 0) {
    throw httpError(
      409,
      "This location is used by existing trips and cannot be deleted. Deactivate it instead."
    );
  }

  await prisma.location.delete({ where: { id } });
}

module.exports = {
  listLocations,
  getLocation,
  createLocation,
  updateLocation,
  deleteLocation,
};