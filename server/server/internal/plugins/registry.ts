import fs from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import type { PluginManifest } from "./types";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A registry entry pins a plugin's version and/or entry checksum. */
export interface PluginRegistryEntry {
  id: string;
  version?: string;
  checksum?: string;
}

export interface PluginRegistryData {
  plugins: PluginRegistryEntry[];
}

/**
 * Optional allow-list / version pinning for external plugins. When entries are
 * present, a plugin must be listed, and any pinned version/checksum must match.
 * An empty registry disables the check (default: trust checksum/signature).
 */
export class PluginRegistry {
  constructor(private readonly entries: PluginRegistryEntry[]) {}

  static async load(filePath: string | undefined): Promise<PluginRegistry> {
    if (!filePath) return new PluginRegistry([]);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      // A configured registry that cannot be read must fail closed.
      throw new Error(`failed to read plugin registry '${filePath}': ${err}`);
    }
    let data: PluginRegistryData;
    try {
      data = JSON.parse(raw) as PluginRegistryData;
    } catch (err) {
      throw new Error(`failed to parse plugin registry '${filePath}': ${err}`);
    }
    return new PluginRegistry(data.plugins ?? []);
  }

  get enabled(): boolean {
    return this.entries.length > 0;
  }

  /** Throw when `manifest`/`digest` violate the registry. */
  check(manifest: PluginManifest, digest: string): void {
    if (!this.enabled) return;
    const entry = this.entries.find(
      (candidate) => candidate.id === manifest.id,
    );
    if (!entry) {
      throw new Error(`plugin '${manifest.id}' is not in the registry`);
    }
    if (entry.version && entry.version !== manifest.version) {
      throw new Error(
        `plugin '${manifest.id}' version ${manifest.version} does not match pinned ${entry.version}`,
      );
    }
    if (entry.checksum) {
      if (
        !SHA256_HEX_PATTERN.test(entry.checksum) ||
        !constantTimeEqual(entry.checksum, digest)
      ) {
        throw new Error(
          `plugin '${manifest.id}' checksum does not match the registry`,
        );
      }
    }
  }
}
