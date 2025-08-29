-- CreateEnum
CREATE TYPE "public"."ImageSourceType" AS ENUM ('FILE', 'URL');

-- CreateEnum
CREATE TYPE "public"."ImageStatus" AS ENUM ('PENDING', 'SAFE', 'RISKY', 'BLOCKED', 'ERROR');

-- CreateTable
CREATE TABLE "public"."Image" (
    "id" TEXT NOT NULL,
    "sourceType" "public"."ImageSourceType" NOT NULL,
    "source" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "mime" TEXT,
    "bytes" INTEGER,
    "status" "public"."ImageStatus" NOT NULL DEFAULT 'PENDING',
    "labels" JSONB,
    "scoreAdult" DOUBLE PRECISION,
    "scoreViolence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);
