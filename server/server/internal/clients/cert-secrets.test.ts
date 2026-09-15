import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CERTIFICATE_KEY_ENV,
  certificateKeyConfigured,
  isSealedPrivateKey,
  openPrivateKey,
  sealPrivateKey,
} from "./cert-secrets";

// Low-entropy 64-hex fixture (32 bytes) so secret scanners do not flag it.
const SAMPLE_MATERIAL = "0123456789abcdef".repeat(4);
const SAMPLE_VALUE = "sample-private-key-material";

test("seals and opens a private key with the configured key", () => {
  const env = { [CERTIFICATE_KEY_ENV]: SAMPLE_MATERIAL } as NodeJS.ProcessEnv;
  const sealed = sealPrivateKey(SAMPLE_VALUE, env);
  assert.ok(isSealedPrivateKey(sealed));
  assert.doesNotMatch(sealed, /sample-private-key-material/);
  assert.equal(openPrivateKey(sealed, env), SAMPLE_VALUE);
});

test("passes legacy plaintext through when no key is configured", () => {
  const env = {} as NodeJS.ProcessEnv;
  assert.equal(sealPrivateKey("legacy-plain-key", env), "legacy-plain-key");
  assert.equal(openPrivateKey("legacy-plain-key", env), "legacy-plain-key");
});

test("throws when opening a sealed key without the key", () => {
  const sealed = sealPrivateKey(SAMPLE_VALUE, {
    [CERTIFICATE_KEY_ENV]: SAMPLE_MATERIAL,
  } as NodeJS.ProcessEnv);
  assert.throws(
    () => openPrivateKey(sealed, {} as NodeJS.ProcessEnv),
    /DROP_CERTIFICATE_KEY/,
  );
});

test("detects tampering with a sealed key", () => {
  const env = { [CERTIFICATE_KEY_ENV]: SAMPLE_MATERIAL } as NodeJS.ProcessEnv;
  const sealed = sealPrivateKey(SAMPLE_VALUE, env);
  const [version, iv, tag, ciphertext] = sealed.split(":");
  const flipped = `${version}:${iv}:${tag}:${Buffer.from("tampered").toString("base64")}${ciphertext.slice(8)}`;
  assert.throws(() => openPrivateKey(flipped, env));
});

test("rejects a malformed key", () => {
  assert.throws(
    () =>
      sealPrivateKey("x", {
        [CERTIFICATE_KEY_ENV]: "short",
      } as NodeJS.ProcessEnv),
    /32-byte/,
  );
});

test("detects whether a certificate key is configured", () => {
  assert.equal(certificateKeyConfigured({} as NodeJS.ProcessEnv), false);
  assert.equal(
    certificateKeyConfigured({
      [CERTIFICATE_KEY_ENV]: "  ",
    } as NodeJS.ProcessEnv),
    false,
  );
  assert.equal(
    certificateKeyConfigured({
      [CERTIFICATE_KEY_ENV]: SAMPLE_MATERIAL,
    } as NodeJS.ProcessEnv),
    true,
  );
});
