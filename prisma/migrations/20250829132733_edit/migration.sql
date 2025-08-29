/*
  Warnings:

  - You are about to drop the `Image` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "public"."Image";

-- DropEnum
DROP TYPE "public"."ImageSourceType";

-- DropEnum
DROP TYPE "public"."ImageStatus";

-- CreateTable
CREATE TABLE "public"."ImageModeration" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageModeration_pkey" PRIMARY KEY ("id")
);
