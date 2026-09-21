-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "radiusMeters" INTEGER;

-- AlterTable
ALTER TABLE "trip_stops" ADD COLUMN     "travelMinutes" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "trip_requests_departureTime_idx" ON "trip_requests"("departureTime");
