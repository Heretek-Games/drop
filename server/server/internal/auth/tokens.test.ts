import { test } from "node:test";
import assert from "node:assert/strict";
import { generateToken, hashToken, TOKEN_BYTES } from "./tokens";

test("generateToken returns unique 256-bit URL-safe tokens", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(a, "base64url").length, TOKEN_BYTES);
});

test("hashToken is deterministic SHA-256 hex and hides the input", () => {
  const token = "example-token";
  const hash = hashToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashToken(token));
  assert.notEqual(hash, token);
});
