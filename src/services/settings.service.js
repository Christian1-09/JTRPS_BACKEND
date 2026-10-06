const prisma = require("../config/prisma");

const DEFAULT_APPROVER_TITLE = "Administrative Officer V/GSO Unit Head";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Single-row table: the first read creates it with the defaults.
async function getSettings(client = prisma) {
  const existing = await client.systemSettings.findFirst();
  if (existing) return existing;
  return client.systemSettings.create({ data: {} });
}

function parseBool(value, field) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw httpError(400, `${field} must be true or false`);
}

function parseText(value, field, { maxLength = 120 } = {}) {
  if (value === null) return null; // clearing the field is allowed
  if (typeof value !== "string") {
    throw httpError(400, `${field} must be text`);
  }
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length > maxLength) {
    throw httpError(400, `${field} must be ${maxLength} characters or less`);
  }
  return clean || null;
}

async function updateSettings(adminId, body) {
  const current = await getSettings();
  const data = {};

  const booleans = [
    "notifyRequesterOnApprovalRejection",
    "notifyDriverWhenAssigned",
    "sendTripCompletionReminder",
    "alertAdminOnOverdueIncompleteTrips",
  ];
  for (const field of booleans) {
    if (body[field] !== undefined) data[field] = parseBool(body[field], field);
  }

  if (body.approverName !== undefined) {
    data.approverName = parseText(body.approverName, "approverName");
  }
  if (body.approverTitle !== undefined) {
    data.approverTitle =
      parseText(body.approverTitle, "approverTitle") ?? DEFAULT_APPROVER_TITLE;
  }

  if (Object.keys(data).length === 0) {
    throw httpError(400, "No settings were provided to update");
  }

  data.updatedById = adminId;

  return prisma.systemSettings.update({ where: { id: current.id }, data });
}

module.exports = { getSettings, updateSettings, DEFAULT_APPROVER_TITLE };