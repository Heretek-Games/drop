#!/usr/bin/env node
/**
 * Sign a Drop plugin bundle.
 *
 * Reads `<bundle>/drop-plugin.json`, computes the SHA-256 of the entry file
 * (default `index.js`), writes it to `checksum`, and — when
 * `DROP_PLUGIN_SIGNING_KEY` is set — writes an HMAC-SHA256 `signature` over
 * that checksum. The manager verifies both before importing a bundle.
 *
 * Usage: node dev-tools/sign-plugin.mjs <bundle-dir>
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const bundleDir = process.argv[2];
if (!bundleDir) {
  console.error("usage: node dev-tools/sign-plugin.mjs <bundle-dir>");
  process.exit(1);
}

const manifestPath = path.join(bundleDir, "drop-plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const entry = manifest.entry ?? "index.js";
const entryBytes = await readFile(path.join(bundleDir, entry));

const checksum = createHash("sha256").update(entryBytes).digest("hex");
manifest.checksum = checksum;

const key = process.env.DROP_PLUGIN_SIGNING_KEY;
if (key) {
  manifest.signature = createHmac("sha256", key).update(checksum).digest("hex");
} else {
  delete manifest.signature;
  console.warn(
    "DROP_PLUGIN_SIGNING_KEY not set; wrote checksum without a signature",
  );
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`signed ${manifest.id ?? bundleDir}: sha256=${checksum}`);
