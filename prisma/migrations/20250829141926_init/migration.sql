/*
  Warnings:

  - You are about to drop the `ImageModeration` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."ImageModeration";

-- CreateTable
CREATE TABLE "public"."ScanResult" (
    "id" SERIAL NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanResult_pkey" PRIMARY KEY ("id")
);
