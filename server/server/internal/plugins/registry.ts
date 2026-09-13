import fs from "node:fs/promises";
import type { PluginManifest } from "./types";

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
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as PluginRegistryData;
      return new PluginRegistry(data.plugins ?? []);
    } catch {
      return new PluginRegistry([]);
    }
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
    if (entry.checksum && entry.checksum !== digest) {
      throw new Error(
        `plugin '${manifest.id}' checksum does not match the registry`,
      );
    }
  }
}
