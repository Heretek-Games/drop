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

const MANIFEST_FILE = "drop-plugin.json";
const SIGNING_KEY_ENV = "DROP_PLUGIN_SIGNING_KEY";

/** True when `candidate` is inside `base` (both absolute, lexically). */
function isInside(base, candidate) {
  const relative = path.relative(base, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

const rawBundleDir = process.argv[2];
if (!rawBundleDir) {
  console.error("usage: node dev-tools/sign-plugin.mjs <bundle-dir>");
  process.exit(1);
}

// Confine the caller-supplied directory to the working directory *before* any
// filesystem access. Absolute paths and `..` escapes are rejected, and the
// symlink-resolved path is re-checked so a symlink cannot escape either.
const cwd = process.cwd();
const resolvedPath = path.resolve(cwd, rawBundleDir);
if (!isInside(cwd, resolvedPath)) {
  console.error("bundle directory must be inside the working directory");
  process.exit(1);
}
const bundleDir = await realpath(resolvedPath).catch(() => null);
if (!bundleDir || !isInside(cwd, bundleDir)) {
  console.error("bundle directory must be inside the working directory");
  process.exit(1);
}
// NOSONAR: `bundleDir` is confined by the isInside checks above; the analyzer
// cannot see the sanitizer.
const bundleStat = await stat(bundleDir).catch(() => null); // NOSONAR
if (!bundleStat?.isDirectory()) {
  console.error("bundle directory must be an existing directory");
  process.exit(1);
}

/** Recursively lists bundle files as POSIX-style relative paths, sorted. */
async function listFiles(root, prefix = "") {
  const results = [];
  // NOSONAR: `root` is the confined bundle directory validated by the caller.
  const entries = await readdir(path.join(root, prefix), {
    withFileTypes: true,
  }); // NOSONAR
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

const manifestPath = path.join(bundleDir, MANIFEST_FILE);
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

const key = process.env[SIGNING_KEY_ENV];
if (key) {
  manifest.signature = createHmac("sha256", key)
    .update(aggregate.digest("hex"))
    .digest("hex");
} else {
  delete manifest.signature;
  console.warn(
    `${SIGNING_KEY_ENV} not set; wrote checksums without a signature`,
  );
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`signed bundle: ${files.length} file(s)`);
