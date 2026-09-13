-- CreateEnum (guarded so this repair migration is idempotent on databases
-- where the type already exists via another path)
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
