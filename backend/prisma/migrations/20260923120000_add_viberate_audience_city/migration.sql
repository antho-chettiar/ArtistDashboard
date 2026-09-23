-- AlterTable
ALTER TABLE "viberate_metrics_daily" ADD COLUMN "city" TEXT;

-- DropIndex
DROP INDEX "viberate_metrics_daily_artistId_metricName_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "viberate_metrics_daily_artistId_metricName_date_city_key" ON "viberate_metrics_daily"("artistId", "metricName", "date", "city");

-- CreateIndex
CREATE INDEX "viberate_metrics_daily_artistId_city_idx" ON "viberate_metrics_daily"("artistId", "city");
