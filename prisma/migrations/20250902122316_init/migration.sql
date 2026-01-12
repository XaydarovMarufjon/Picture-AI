/*
  Warnings:

  - You are about to drop the `ImageCheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."ImageCheck";

-- CreateTable
CREATE TABLE "public"."Scan" (
    "id" SERIAL NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'finished',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScanItem" (
    "id" SERIAL NOT NULL,
    "scanId" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScanItem_scanId_idx" ON "public"."ScanItem"("scanId");

-- CreateIndex
CREATE INDEX "ScanItem_imageUrl_idx" ON "public"."ScanItem"("imageUrl");

-- AddForeignKey
ALTER TABLE "public"."ScanItem" ADD CONSTRAINT "ScanItem_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "public"."Scan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
