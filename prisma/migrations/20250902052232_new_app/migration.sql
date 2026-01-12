/*
  Warnings:

  - You are about to drop the `ScanResult` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."ScanResult";

-- CreateTable
CREATE TABLE "public"."ImageCheck" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageCheck_pkey" PRIMARY KEY ("id")
);
