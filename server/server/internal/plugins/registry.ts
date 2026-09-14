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
  name?: string;
  version?: string;
  checksum?: string;
  url?: string;
  downloadUrl?: string;
  description?: string;
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
  /**
   * @param strict When true (a registry file/URL is configured), the registry is
   * authoritative even when empty: every plugin is denied. A non-strict empty
   * registry (no file configured) disables pinning.
   */
  constructor(
    private readonly entries: PluginRegistryEntry[],
    private readonly strict = false,
  ) {}

  static async load(source: string | undefined): Promise<PluginRegistry> {
    if (!source) return new PluginRegistry([], false);
    let raw: string;
    if (source.startsWith("http://") || source.startsWith("https://")) {
      try {
        const res = await fetch(source, {
          signal: AbortSignal.timeout(10000),
          headers: { "User-Agent": "Drop-Plugin-Registry/1.0" },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        raw = await res.text();
      } catch (err) {
        // A configured remote registry that cannot be fetched must fail closed.
        throw new Error(
          `failed to fetch remote plugin registry '${source}': ${err}`,
        );
      }
    } else {
      try {
        raw = await fs.readFile(source, "utf-8");
      } catch (err) {
        // A configured registry that cannot be read must fail closed.
        throw new Error(`failed to read plugin registry '${source}': ${err}`);
      }
    }
    let data: PluginRegistryData;
    try {
      data = JSON.parse(raw) as PluginRegistryData;
    } catch (err) {
      throw new Error(`failed to parse plugin registry '${source}': ${err}`);
    }
    // A syntactically valid but empty registry (`{}` / `{"plugins":null}`)
    // must deny, not silently disable pinning.
    return new PluginRegistry(data.plugins ?? [], true);
  }

  getEntry(id: string): PluginRegistryEntry | undefined {
    return this.entries.find((candidate) => candidate.id === id);
  }

  listEntries(): PluginRegistryEntry[] {
    return [...this.entries];
  }

  get enabled(): boolean {
    return this.strict || this.entries.length > 0;
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
    if (
      entry.checksum &&
      (!SHA256_HEX_PATTERN.test(entry.checksum) ||
        !constantTimeEqual(entry.checksum, digest))
    ) {
      throw new Error(
        `plugin '${manifest.id}' checksum does not match the registry`,
      );
    }
  }
}
