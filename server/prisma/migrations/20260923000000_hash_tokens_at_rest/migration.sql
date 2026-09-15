-- Store only SHA-256 digests of bearer tokens at rest.
--
-- Session cookies and API tokens are looked up by hashing the presented value,
-- so migrating the existing rows in place keeps every live session and token
-- working. Requires PostgreSQL's built-in sha256(bytea) function.

-- API tokens are now generated in application code and stored hashed, so the
-- raw-UUID default is removed.
ALTER TABLE "APIToken" ALTER COLUMN "token" DROP DEFAULT;

UPDATE "APIToken" SET "token" = encode(sha256("token"::bytea), 'hex');
UPDATE "Session" SET "token" = encode(sha256("token"::bytea), 'hex');
