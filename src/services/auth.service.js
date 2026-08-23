const bcrypt = require("bcryptjs");
const prisma = require("../config/prisma");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");

const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, keep in sync with .env

async function register({ email, password, fullName, phone, role }) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const err = new Error("Email already in use");
    err.status = 409;
    throw err;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: { email, password: hashedPassword, fullName, phone, role },
  });

  return sanitizeUser(user);
}

async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
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
