-- CreateEnum
CREATE TYPE "ServiceMode" AS ENUM ('WAIT', 'DROP_AND_PICKUP');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TripRequestStatus" ADD VALUE 'DRIVER_ACCEPTED';
ALTER TYPE "TripRequestStatus" ADD VALUE 'DRIVER_DECLINED';

-- DropIndex
DROP INDEX "trip_requests_driverId_idx";

-- AlterTable
ALTER TABLE "trip_requests" ADD COLUMN     "driverAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "pickupTime" TIMESTAMP(3),
ADD COLUMN     "serviceMode" "ServiceMode" NOT NULL DEFAULT 'WAIT';

-- AlterTable
ALTER TABLE "trip_stops" ADD COLUMN     "locationId" TEXT;

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "travelMinutes" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_driver_declines" (
    "id" TEXT NOT NULL,
    "tripRequestId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "declinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_driver_declines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_name_key" ON "locations"("name");

-- CreateIndex
CREATE INDEX "trip_driver_declines_driverId_idx" ON "trip_driver_declines"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "trip_driver_declines_tripRequestId_driverId_key" ON "trip_driver_declines"("tripRequestId", "driverId");

-- CreateIndex
CREATE INDEX "trip_requests_driverId_status_idx" ON "trip_requests"("driverId", "status");

-- CreateIndex
CREATE INDEX "trip_requests_vehicleId_status_idx" ON "trip_requests"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "trip_stops_locationId_idx" ON "trip_stops"("locationId");

-- AddForeignKey
ALTER TABLE "trip_driver_declines" ADD CONSTRAINT "trip_driver_declines_tripRequestId_fkey" FOREIGN KEY ("tripRequestId") REFERENCES "trip_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_driver_declines" ADD CONSTRAINT "trip_driver_declines_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
