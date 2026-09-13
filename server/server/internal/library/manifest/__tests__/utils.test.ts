import test from "node:test";
import assert from "node:assert/strict";
import { castManifest } from "../utils";

// Regression: recipe embedding started storing manifests as JSONB objects,
// but castManifest only handled the historical JSON-string shape.
test("castManifest accepts the object shape returned from JSONB", () => {
  const manifest = { chunks: { a: { files: [] } } };
  assert.deepEqual(castManifest(manifest), manifest);
});

test("castManifest still accepts the legacy JSON-string shape", () => {
  const manifest = { chunks: { a: { files: [] } } };
  assert.deepEqual(castManifest(JSON.stringify(manifest)), manifest);
});
