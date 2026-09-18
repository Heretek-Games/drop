-- Map external authentication provider identities to local Drop accounts so
-- the login flow can attach an external AuthUser (e.g. an LDAP directory
-- entry) to a user without storing provider-specific state on the user row.
CREATE TABLE "ExternalIdentity" (
    "providerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("providerId", "externalId")
);

-- CreateIndex
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Explicit admin opt-in for plugin AuthProviders. Empty means external
-- authentication is disabled (fail closed).
ALTER TABLE "ApplicationSettings" ADD COLUMN "authProviders" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
