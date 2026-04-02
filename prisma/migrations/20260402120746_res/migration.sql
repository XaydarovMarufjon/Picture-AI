/*
  Warnings:

  - A unique constraint covering the columns `[hash]` on the table `ScanItem` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `hash` to the `ScanItem` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."ScanItem" ADD COLUMN     "hash" TEXT NOT NULL,
ALTER COLUMN "raw" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ScanItem_hash_key" ON "public"."ScanItem"("hash");
