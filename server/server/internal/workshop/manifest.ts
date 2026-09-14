import { createError } from "h3";

/**
 * `mod.json` manifest for The Drop Workshop (#20).
 *
 * A manifest is the portable description of a mod: its identity, the game
 * release it targets, its dependency graph, and the files it ships. It is
 * validated before it is stored so a malformed or hostile manifest can never
 * reach the desktop mod manager (path traversal, absolute paths, unknown
 * shapes).
 */

export interface ModDependency {
  id: string;
  version?: string;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  game?: {
    appId?: string;
    version?: string;
  };
  dependencies: ModDependency[];
  files: string[];
}

/** Loose semver: MAJOR.MINOR.PATCH with optional prerelease/build metadata. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Reject absolute paths and `..` traversal in bundled mod files. */
export function isSafeModPath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}

function parseDependencies(value: unknown): ModDependency[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("dependencies must be an array");
  return value.map((entry) => {
    if (typeof entry === "string") {
      return { id: requireString(entry, "dependency id") };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("each dependency must be a string or an object");
    }
    const record = entry as Record<string, unknown>;
    const id = requireString(record.id, "dependency id");
    const version = optionalString(record.version);
    return version ? { id, version } : { id };
  });
}

function parseFiles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("files must be an array");
  return value.map((entry) => {
    const path = requireString(entry, "file path");
    if (!isSafeModPath(path)) {
      fail(`unsafe file path '${path}'`);
    }
    return path;
  });
}

function parseGame(value: unknown): ModManifest["game"] {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("game must be an object");
  }
  const record = value as Record<string, unknown>;
  const appId = optionalString(record.appId);
  const version = optionalString(record.version);
  if (!appId && !version) return undefined;
  return { ...(appId ? { appId } : {}), ...(version ? { version } : {}) };
}

/** Parse and validate a `mod.json` payload. */
export function parseModManifest(input: unknown): ModManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("manifest must be an object");
  }
  const raw = input as Record<string, unknown>;
  const id = requireString(raw.id, "id");
  const name = requireString(raw.name, "name");
  const version = requireString(raw.version, "version");
  if (!VERSION_RE.test(version)) {
    fail("version must be semver (MAJOR.MINOR.PATCH)");
  }

  const manifest: ModManifest = {
    id,
    name,
    version,
    dependencies: parseDependencies(raw.dependencies),
    files: parseFiles(raw.files),
  };
  const author = optionalString(raw.author);
  if (author) manifest.author = author;
  const description = optionalString(raw.description);
  if (description) manifest.description = description;
  const game = parseGame(raw.game);
  if (game) manifest.game = game;

  return manifest;
}
