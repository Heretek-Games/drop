-- CreateTable
CREATE TABLE "UninstallConfiguration" (
    "uninstallId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "versionId" TEXT NOT NULL,

    CONSTRAINT "UninstallConfiguration_pkey" PRIMARY KEY ("uninstallId")
);

-- AddForeignKey
ALTER TABLE "UninstallConfiguration" ADD CONSTRAINT "UninstallConfiguration_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "GameVersion"("versionId") ON DELETE CASCADE ON UPDATE CASCADE;
