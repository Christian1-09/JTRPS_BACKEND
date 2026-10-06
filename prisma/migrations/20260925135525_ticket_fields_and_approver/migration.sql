-- AlterTable
ALTER TABLE "system_settings" ADD COLUMN     "approverName" TEXT,
ADD COLUMN     "approverTitle" TEXT DEFAULT 'Administrative Officer V/GSO Unit Head';

-- AlterTable
ALTER TABLE "trip_returns" ADD COLUMN     "arrivedAtDestination" TIMESTAMP(3),
ADD COLUMN     "departedFromDestination" TIMESTAMP(3);
