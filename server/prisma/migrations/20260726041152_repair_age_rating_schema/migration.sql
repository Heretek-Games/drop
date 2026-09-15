-- Repair migration for the age-rating schema drift.
--
-- The "AgeRatingOrganization" enum and "GameAgeRating" table were originally
-- added by editing the already-applied
-- "20260224145112_add_non_null_default_to_carousel_object_ids" migration.
-- Databases that applied that migration before the age-rating change never
-- created those objects, which makes "20260726041153_add_user_groups" fail
-- with `type "AgeRatingOrganization" does not exist`.
--
-- This migration is intentionally named to sort *before*
-- "20260726041153_add_user_groups" so that prisma migrate deploy creates the
-- enum ahead of that migration, while remaining a no-op on databases that
-- already have these objects.
--
-- Note: databases that already recorded "20260726041153_add_user_groups" as
-- failed must first mark it rolled back:
--   pnpm prisma migrate resolve --rolled-back 20260726041153_add_user_groups

-- CreateEnum (guarded; databases that ran the edited carousel migration
-- already have this type)
DO $$ BEGIN
    CREATE TYPE "AgeRatingOrganization" AS ENUM ('ESRB', 'PEGI', 'CERO', 'USK', 'GRAC', 'ClassInd', 'ACB');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "GameAgeRating" (
    "id" TEXT NOT NULL,
    "organization" "AgeRatingOrganization" NOT NULL,
    "rating" TEXT NOT NULL,
    "ratingCoverUrl" TEXT,
    "gameId" TEXT NOT NULL,

    CONSTRAINT "GameAgeRating_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "GameAgeRating_gameId_organization_key" ON "GameAgeRating"("gameId", "organization");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "GameAgeRating" ADD CONSTRAINT "GameAgeRating_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
