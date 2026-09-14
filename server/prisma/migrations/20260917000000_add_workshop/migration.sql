-- CreateTable
CREATE TABLE "Mod" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "author" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModRelease" (
    "id" TEXT NOT NULL,
    "modId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" TEXT NOT NULL,
    "downloadUrl" TEXT,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "modId" TEXT NOT NULL,
    "pinnedVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mod_gameId_key_key" ON "Mod"("gameId", "key");

-- CreateIndex
CREATE INDEX "Mod_gameId_idx" ON "Mod"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "ModRelease_modId_version_key" ON "ModRelease"("modId", "version");

-- CreateIndex
CREATE INDEX "ModRelease_modId_idx" ON "ModRelease"("modId");

-- CreateIndex
CREATE UNIQUE INDEX "ModSubscription_userId_modId_key" ON "ModSubscription"("userId", "modId");

-- CreateIndex
CREATE INDEX "ModSubscription_userId_idx" ON "ModSubscription"("userId");

-- AddForeignKey
ALTER TABLE "Mod" ADD CONSTRAINT "Mod_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModRelease" ADD CONSTRAINT "ModRelease_modId_fkey" FOREIGN KEY ("modId") REFERENCES "Mod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModSubscription" ADD CONSTRAINT "ModSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModSubscription" ADD CONSTRAINT "ModSubscription_modId_fkey" FOREIGN KEY ("modId") REFERENCES "Mod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
