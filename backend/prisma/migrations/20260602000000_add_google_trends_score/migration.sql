-- AlterTable
ALTER TABLE "artists" ADD COLUMN IF NOT EXISTS "googleTrendsScore" DECIMAL(5,2);
