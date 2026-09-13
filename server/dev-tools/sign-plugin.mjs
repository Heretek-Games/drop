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
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const rawBundleDir = process.argv[2];
if (!rawBundleDir) {
  console.error("usage: node dev-tools/sign-plugin.mjs <bundle-dir>");
  process.exit(1);
}

// Resolve and confine the caller-supplied path to the working directory so a
// crafted argument cannot point the signer at an arbitrary location.
const cwd = await realpath(process.cwd());
const bundleDir = await realpath(path.resolve(rawBundleDir)).catch(() => null);
if (!bundleDir || !(await stat(bundleDir).catch(() => null))?.isDirectory()) {
  console.error(`not a directory: ${rawBundleDir}`);
  process.exit(1);
}
const relativeBundleDir = path.relative(cwd, bundleDir);
if (relativeBundleDir.startsWith("..") || path.isAbsolute(relativeBundleDir)) {
  console.error(
    "bundle directory must be inside the current working directory",
  );
  process.exit(1);
}

const MANIFEST_FILE = "drop-plugin.json";

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
      // The manifest cannot checksum itself; the manager excludes it too.
      if (!prefix && entry.name === MANIFEST_FILE) continue;
      results.push(rel);
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
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
  `signed ${manifest.id ?? relativeBundleDir}: ${files.length} file(s)`,
);
