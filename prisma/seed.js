// Seeds a single Admin account with a properly bcrypt-hashed password.
// Safe to run multiple times — if the admin email already exists, it's
// left untouched (won't overwrite a password you've since changed).
//
// Run it with:   npx prisma db seed
// Or in Docker:  docker compose exec api npx prisma db seed
//
// Override the defaults below by setting these in your .env file:
//   SEED_ADMIN_EMAIL
//   SEED_ADMIN_PASSWORD
//   SEED_ADMIN_FULLNAME

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@tripticket.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
const ADMIN_FULLNAME = process.env.SEED_ADMIN_FULLNAME || "System Admin";

async function main() {
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
  });

  if (existing) {
    console.log(`Admin account already exists (${ADMIN_EMAIL}) — skipping, nothing changed.`);
    return;
  }

  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      password: hashedPassword,
      fullName: ADMIN_FULLNAME,
      role: "ADMIN",
      isActive: true,
      isApproved: true,
    },
  });

  console.log("✅ Admin account created:");
  console.log(`   Email:    ${admin.email}`);
  console.log(`   Password: ${ADMIN_PASSWORD}  (only shown here — not stored anywhere in plain text)`);
  console.log(`   Role:     ${admin.role}`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });