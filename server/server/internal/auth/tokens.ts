import { createHash, randomBytes } from "node:crypto";

/**
 * Opaque credential generation and hashing.
 *
 * Session cookies and API tokens are bearer credentials: whoever holds the raw
 * value is authenticated. They are therefore never persisted in plaintext —
 * only their SHA-256 digest is stored, and lookups hash the presented value.
 * SHA-256 is used (not a password KDF) because the token itself is 256 bits of
 * CSPRNG entropy, so brute-forcing the preimage is infeasible.
 */

/** Bytes of entropy in a generated token (256 bits). */
export const TOKEN_BYTES = 32;

/** Generates a URL-safe, 256-bit random token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Hex SHA-256 digest used as the persisted/looked-up form of a token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
