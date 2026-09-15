import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for the certificate authority's private keys.
 *
 * The CA private key and per-client private keys in the `Certificate` table are
 * sealed with AES-256-GCM under an operator key so a database read (dump,
 * backup, stolen volume) does not yield a usable signing key. When no key is
 * configured the value is stored as-is to preserve compatibility with existing
 * installs; the server logs a warning at startup (see `clients/ca.ts`).
 */
export const CERTIFICATE_KEY_ENV = "DROP_CERTIFICATE_KEY";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function loadKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[CERTIFICATE_KEY_ENV];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  throw new Error(
    `${CERTIFICATE_KEY_ENV} must be a 32-byte key encoded as 64 hex characters or base64`,
  );
}

export function isSealedPrivateKey(value: string): boolean {
  return value.startsWith(`${VERSION}:`);
}

/** Whether an at-rest encryption key is configured for certificate keys. */
export function certificateKeyConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[CERTIFICATE_KEY_ENV]?.trim());
}

/** Encrypts a private key for storage; returns plaintext when no key is set. */
export function sealPrivateKey(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = loadKey(env);
  if (!key) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypts a stored private key, passing legacy plaintext through untouched. */
export function openPrivateKey(
  stored: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isSealedPrivateKey(stored)) return stored;
  const key = loadKey(env);
  if (!key) {
    throw new Error(
      `Certificate private key is encrypted; set ${CERTIFICATE_KEY_ENV} to decrypt it`,
    );
  }
  const [version, ivB64, tagB64, ciphertextB64] = stored.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Malformed sealed certificate private key");
  }
  const tag = Buffer.from(tagB64, "base64");
  if (tag.length !== TAG_BYTES) {
    throw new Error("Unsupported certificate auth tag length");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
    { authTagLength: TAG_BYTES },
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
