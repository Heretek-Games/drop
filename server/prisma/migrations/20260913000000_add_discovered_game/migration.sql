-- CreateEnum
CREATE TYPE "DiscoveredGameDecision" AS ENUM ('Pending', 'Imported', 'Ignored');

-- CreateTable
CREATE TABLE "DiscoveredGame" (
    "id" TEXT NOT NULL,
    "libraryId" TEXT NOT NULL,
    "libraryPath" TEXT NOT NULL,
    "inferredType" TEXT NOT NULL,
    "suggestedName" TEXT,
    "decision" "DiscoveredGameDecision" NOT NULL DEFAULT 'Pending',
    "importedGameId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredGame_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredGame_libraryId_libraryPath_key" ON "DiscoveredGame"("libraryId", "libraryPath");

-- CreateIndex
CREATE INDEX "DiscoveredGame_decision_idx" ON "DiscoveredGame"("decision");

-- AddForeignKey
ALTER TABLE "DiscoveredGame" ADD CONSTRAINT "DiscoveredGame_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "Library"("id") ON DELETE CASCADE ON UPDATE CASCADE;
