const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");

const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, keep in sync with .env

// ADMIN is created manually in the database. HEAD_DRIVER is assigned only by
// an Admin promoting an approved Driver. Neither is ever self-registered.
// (The controller checks this too — this is a second safety layer.)
const SELF_REGISTER_ROLES = ["DRIVER", "FACULTY", "STAFF", "SSG_PRESIDENT"];

const MAX_DRIVER_CODE_RETRIES = 3;

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// Uses the HIGHEST existing number for this year + 1 (not count + 1),
// so codes never repeat after a driver is rejected (deleted).
async function generateDriverCode(tx) {
  const year = new Date().getFullYear();
  const prefix = `DRV-${year}-`;

  const existing = await tx.driverProfile.findMany({
    where: { driverCode: { startsWith: prefix } },
    select: { driverCode: true },
  });

  const highest = existing.reduce((max, { driverCode }) => {
    const num = parseInt(driverCode.slice(prefix.length), 10);
    return Number.isNaN(num) ? max : Math.max(max, num);
  }, 0);

  const sequence = String(highest + 1).padStart(3, "0");
  return `${prefix}${sequence}`;
}

function isUniqueError(err, field) {
  if (err?.code !== "P2002") return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === "string" && target.includes(field);
}

async function register({ email, password, fullName, phone, role }) {
  if (!SELF_REGISTER_ROLES.includes(role)) {
    const err = new Error(`role must be one of: ${SELF_REGISTER_ROLES.join(", ")}`);
    err.status = 400;
    throw err;
  }

  const cleanEmail = normalizeEmail(email);

  const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existing) {
    const err = new Error("Email already in use");
    err.status = 409;
    throw err;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  // Drivers need Admin approval before they can log in. Every other
  // self-registered role (Faculty/Staff/SSG President) is approved
  // immediately.
  const isDriver = role === "DRIVER";
  const isApproved = !isDriver;

  // Retry only when two drivers registered at the same moment and
  // got the same driverCode. Any other error is thrown immediately.
  for (let attempt = 1; attempt <= MAX_DRIVER_CODE_RETRIES; attempt++) {
    try {
      // One transaction: the user and their DriverProfile are saved
      // together, or neither is saved. No more users without a profile.
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: cleanEmail,
            password: hashedPassword,
            fullName: String(fullName).trim(),
            phone,
            role,
            isApproved,
          },
        });

        // Drivers additionally need a DriverProfile row — without one, they
        // can never appear in the "available drivers" list, even after approval.
        if (isDriver) {
          const driverCode = await generateDriverCode(tx);
          await tx.driverProfile.create({
            data: {
              userId: created.id,
              driverCode,
              status: "AVAILABLE",
            },
          });
        }

        return created;
      });

      return sanitizeUser(user);
    } catch (err) {
      if (isUniqueError(err, "email")) {
        const e = new Error("Email already in use");
        e.status = 409;
        throw e;
      }
      if (isUniqueError(err, "driverCode") && attempt < MAX_DRIVER_CODE_RETRIES) {
        continue; // someone took this code a moment ago — try again
      }
      throw err;
    }
  }
}

async function login({ identifier, password }) {
  const isEmail = identifier.includes("@");
  let user;

  if (isEmail) {
    user = await prisma.user.findUnique({ where: { email: normalizeEmail(identifier) } });
  } else {
    const matches = await prisma.user.findMany({
      where: { fullName: { equals: identifier.trim(), mode: "insensitive" } },
    });

    if (matches.length > 1) {
      const err = new Error(
        "Multiple accounts share this name. Please log in with your email instead."
      );
      err.status = 409;
      throw err;
    }

    user = matches[0];
  }

  if (!user || !user.isActive) {
    const err = new Error("Invalid credentials");
    err.status = 401;
    throw err;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    const err = new Error("Invalid credentials");
    err.status = 401;
    throw err;
  }

  if (!user.isApproved) {
    const err = new Error("Your account is pending admin approval.");
    err.status = 403;
    throw err;
  }

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_EXPIRES_MS),
    },
  });

  return { user: sanitizeUser(user), accessToken, refreshToken };
}

async function refresh(refreshToken) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    const e = new Error("Invalid or expired refresh token");
    e.status = 401;
    throw e;
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!stored || stored.expiresAt < new Date()) {
    const err = new Error("Refresh token not recognized or expired");
    err.status = 401;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) {
    const err = new Error("User not found or inactive");
    err.status = 401;
    throw err;
  }

  const newAccessToken = signAccessToken(user);
  return { accessToken: newAccessToken };
}

async function logout(refreshToken) {
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

module.exports = { register, login, refresh, logout };