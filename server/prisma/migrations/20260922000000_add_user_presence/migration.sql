-- CreateTable
CREATE TABLE "UserPresence" (
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'online',
    "gameId" TEXT,
    "updatedAt" TIMESTAMPTZ(0) NOT NULL,

    CONSTRAINT "UserPresence_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "UserPresence_updatedAt_idx" ON "UserPresence"("updatedAt");

-- AddForeignKey
ALTER TABLE "UserPresence" ADD CONSTRAINT "UserPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
