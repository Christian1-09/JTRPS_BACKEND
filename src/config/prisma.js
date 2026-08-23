const { PrismaClient } = require("@prisma/client");

// Reuse a single PrismaClient instance across the app (avoids exhausting
// Postgres connections, especially important with nodemon hot-reloads).
const prisma = new PrismaClient();

module.exports = prisma;
