/*
  Warnings:

  - Added the required column `provider` to the `ScanItem` table without a default value. This is not possible if the table is not empty.
  - Made the column `raw` on table `ScanItem` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "public"."ScanItem_imageUrl_idx";

-- DropIndex
DROP INDEX "public"."ScanItem_scanId_idx";

-- AlterTable
ALTER TABLE "public"."ScanItem" ADD COLUMN     "provider" TEXT NOT NULL,
ALTER COLUMN "raw" SET NOT NULL;
