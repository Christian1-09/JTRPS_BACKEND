/*
  Warnings:

  - You are about to drop the column `driverId` on the `vehicles` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[employeeId]` on the table `driver_profiles` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "vehicles" DROP CONSTRAINT "vehicles_driverId_fkey";

-- DropIndex
DROP INDEX "vehicles_driverId_key";

-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "incidentCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "vehicles" DROP COLUMN "driverId";

-- CreateTable
CREATE TABLE "vehicle_assignments" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_assignments_driverId_idx" ON "vehicle_assignments"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_assignments_vehicleId_driverId_key" ON "vehicle_assignments"("vehicleId", "driverId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_employeeId_key" ON "driver_profiles"("employeeId");

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
