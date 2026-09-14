-- CreateTable
CREATE TABLE "GamePrice" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamePrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GamePrice_gameId_currency_key" ON "GamePrice"("gameId", "currency");

-- CreateIndex
CREATE INDEX "GamePrice_gameId_idx" ON "GamePrice"("gameId");

-- AddForeignKey
ALTER TABLE "GamePrice" ADD CONSTRAINT "GamePrice_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
