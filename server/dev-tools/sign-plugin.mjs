#!/usr/bin/env node
/**
 * Sign a Drop plugin bundle.
 *
 * Reads `<bundle>/drop-plugin.json`, computes the SHA-256 of the entry file
 * (default `index.js`) into `checksum`, records a `files` map covering every
 * bundle file, and — when `DROP_PLUGIN_SIGNING_KEY` is set — writes an
 * HMAC-SHA256 `signature` over the aggregate bundle digest. The manager
 * verifies all of these (and refuses multi-file bundles without `files`)
 * before importing a bundle.
 *
 * Usage: node dev-tools/sign-plugin.mjs <bundle-dir>
 */
import { createHash, createHmac } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const bundleDir = process.argv[2];
if (!bundleDir) {
  console.error("usage: node dev-tools/sign-plugin.mjs <bundle-dir>");
  process.exit(1);
}

/** Recursively lists bundle files as POSIX-style relative paths, sorted. */
async function listFiles(root, prefix = "") {
  const results = [];
  const entries = await readdir(path.join(root, prefix), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      results.push(...(await listFiles(root, rel)));
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
  return results.sort();
}

const manifestPath = path.join(bundleDir, "drop-plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const entry = manifest.entry ?? "index.js";
const entryBytes = await readFile(path.join(bundleDir, entry));

const checksum = createHash("sha256").update(entryBytes).digest("hex");
manifest.checksum = checksum;

const files = await listFiles(bundleDir);
const fileChecksums = {};
const aggregate = createHash("sha256");
for (const rel of files) {
  const bytes = await readFile(path.join(bundleDir, rel));
  fileChecksums[rel] = createHash("sha256").update(bytes).digest("hex");
  aggregate.update(rel);
  aggregate.update("\0");
  aggregate.update(String(bytes.length));
  aggregate.update("\0");
  aggregate.update(bytes);
}
manifest.files = fileChecksums;

const key = process.env.DROP_PLUGIN_SIGNING_KEY;
if (key) {
  manifest.signature = createHmac("sha256", key)
    .update(aggregate.digest("hex"))
    .digest("hex");
} else {
  delete manifest.signature;
  console.warn(
    "DROP_PLUGIN_SIGNING_KEY not set; wrote checksums without a signature",
  );
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `signed ${manifest.id ?? bundleDir}: ${files.length} file(s), sha256=${checksum}`,
);
