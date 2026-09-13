-- CreateTable
CREATE TABLE "GseRoom" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GseRoom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GseRoom_gameId_idx" ON "GseRoom"("gameId");

-- CreateIndex
CREATE INDEX "GseRoom_expiresAt_idx" ON "GseRoom"("expiresAt");

-- CreateTable
CREATE TABLE "GseCredential" (
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GseCredential_pkey" PRIMARY KEY ("roomId","userId")
);
