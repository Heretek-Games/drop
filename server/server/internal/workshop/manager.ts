import { createError } from "h3";
import { parseModManifest, type ModManifest } from "./manifest";

export interface ModRecord {
  id: string;
  gameId: string;
  key: string;
  name: string;
  summary: string;
  author?: string | null;
  createdAt: Date;
}

export interface ModReleaseRecord {
  id: string;
  modId: string;
  version: string;
  manifest: string;
  downloadUrl?: string | null;
  checksum?: string | null;
  createdAt: Date;
}

export interface ModSubscriptionRecord {
  userId: string;
  modId: string;
  pinnedVersion?: string | null;
  createdAt: Date;
}

/** A subscription joined with the mod it targets (for client load planning). */
export interface ModSubscriptionView extends ModSubscriptionRecord {
  mod?: {
    id: string;
    gameId: string;
    key: string;
    name: string;
  } | null;
}

export interface PublishModInput {
  gameId: string;
  manifest: unknown;
  summary?: string;
  downloadUrl?: string;
  checksum?: string;
}

/** Dependency surface kept structural so the manager is unit-testable. */
export interface WorkshopDeps {
  prisma: {
    mod: {
      findUnique(args: {
        where: { gameId_key: { gameId: string; key: string } };
      }): Promise<ModRecord | null>;
      create(args: {
        data: {
          gameId: string;
          key: string;
          name: string;
          summary: string;
          author?: string;
        };
      }): Promise<ModRecord>;
      update(args: {
        where: { id: string };
        data: { name: string; summary: string; author?: string | null };
      }): Promise<ModRecord>;
      findMany(args: {
        where: { gameId: string };
        orderBy?: { createdAt: "asc" | "desc" };
      }): Promise<ModRecord[]>;
    };
    modRelease: {
      findUnique(args: {
        where: { modId_version: { modId: string; version: string } };
      }): Promise<ModReleaseRecord | null>;
      create(args: {
        data: {
          modId: string;
          version: string;
          manifest: string;
          downloadUrl?: string;
          checksum?: string;
        };
      }): Promise<ModReleaseRecord>;
      findMany(args: {
        where: { modId: string };
        orderBy?: { createdAt: "asc" | "desc" };
      }): Promise<ModReleaseRecord[]>;
    };
    modSubscription: {
      findUnique(args: {
        where: { userId_modId: { userId: string; modId: string } };
      }): Promise<ModSubscriptionRecord | null>;
      create(args: {
        data: { userId: string; modId: string; pinnedVersion?: string };
      }): Promise<ModSubscriptionRecord>;
      update(args: {
        where: { userId_modId: { userId: string; modId: string } };
        data: { pinnedVersion?: string | null };
      }): Promise<ModSubscriptionRecord>;
      delete(args: {
        where: { userId_modId: { userId: string; modId: string } };
      }): Promise<ModSubscriptionRecord>;
      findMany(args: {
        where: { userId: string };
      }): Promise<ModSubscriptionView[]>;
    };
  };
}

/**
 * Compare two semver-ish versions by numeric core. Prerelease/build metadata is
 * ignored beyond string comparison, which is sufficient for "pick latest".
 */
export function compareVersions(a: string, b: string): number {
  const core = (value: string) => value.split(/[-+]/, 1)[0].split(".");
  const left = core(a);
  const right = core(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number(left[i] ?? 0);
    const r = Number(right[i] ?? 0);
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/** Highest semver release, or `null` when there are none. */
export function latestRelease(
  releases: ModReleaseRecord[],
): ModReleaseRecord | null {
  let latest: ModReleaseRecord | null = null;
  for (const release of releases) {
    if (!latest || compareVersions(release.version, latest.version) > 0) {
      latest = release;
    }
  }
  return latest;
}

/**
 * Resolve the install order for a manifest's dependency graph (dependencies
 * before dependents). Missing ids are reported; a cycle is rejected.
 */
export function resolveInstallPlan(
  manifest: ModManifest,
  lookup: (id: string) => ModManifest | undefined,
): { order: string[]; missing: string[] } {
  const order: string[] = [];
  const missing: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (current: ModManifest): void => {
    if (visited.has(current.id)) return;
    if (visiting.has(current.id)) {
      throw createError({
        statusCode: 400,
        statusMessage: `Dependency cycle detected at '${current.id}'`,
      });
    }
    visiting.add(current.id);
    for (const dependency of current.dependencies) {
      const resolved = lookup(dependency.id);
      if (!resolved) {
        if (!missing.includes(dependency.id)) missing.push(dependency.id);
        continue;
      }
      visit(resolved);
    }
    visiting.delete(current.id);
    visited.add(current.id);
    order.push(current.id);
  };

  visit(manifest);
  return { order, missing };
}

export class WorkshopManager {
  constructor(private readonly deps: WorkshopDeps) {}

  /** Registers or updates a mod and its release from a validated manifest. */
  async publish(input: PublishModInput): Promise<{
    mod: ModRecord;
    release: ModReleaseRecord;
    manifest: ModManifest;
  }> {
    const manifest = parseModManifest(input.manifest);
    const summary = input.summary ?? manifest.description ?? "";
    const existing = await this.deps.prisma.mod.findUnique({
      where: { gameId_key: { gameId: input.gameId, key: manifest.id } },
    });
    const mod = existing
      ? await this.deps.prisma.mod.update({
          where: { id: existing.id },
          data: {
            name: manifest.name,
            summary,
            author: manifest.author ?? null,
          },
        })
      : await this.deps.prisma.mod.create({
          data: {
            gameId: input.gameId,
            key: manifest.id,
            name: manifest.name,
            summary,
            ...(manifest.author ? { author: manifest.author } : {}),
          },
        });

    const existingRelease = await this.deps.prisma.modRelease.findUnique({
      where: { modId_version: { modId: mod.id, version: manifest.version } },
    });
    const release =
      existingRelease ??
      (await this.deps.prisma.modRelease.create({
        data: {
          modId: mod.id,
          version: manifest.version,
          manifest: JSON.stringify(manifest),
          ...(input.downloadUrl ? { downloadUrl: input.downloadUrl } : {}),
          ...(input.checksum ? { checksum: input.checksum } : {}),
        },
      }));

    return { mod, release, manifest };
  }

  async listMods(gameId: string): Promise<ModRecord[]> {
    return this.deps.prisma.mod.findMany({
      where: { gameId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** A mod with its releases (newest first) and resolved latest release. */
  async getMod(
    gameId: string,
    key: string,
  ): Promise<{
    mod: ModRecord;
    releases: Array<ModReleaseRecord & { parsed: ModManifest }>;
    latest: (ModReleaseRecord & { parsed: ModManifest }) | null;
  }> {
    const mod = await this.deps.prisma.mod.findUnique({
      where: { gameId_key: { gameId, key } },
    });
    if (!mod) {
      throw createError({ statusCode: 404, statusMessage: "Unknown mod" });
    }
    const releases = await this.deps.prisma.modRelease.findMany({
      where: { modId: mod.id },
      orderBy: { createdAt: "desc" },
    });
    const withParsed = releases.map((release) => ({
      ...release,
      parsed: parseModManifest(JSON.parse(release.manifest)),
    }));
    const latestRecord = latestRelease(releases);
    const latest = latestRecord
      ? (withParsed.find((r) => r.id === latestRecord.id) ?? null)
      : null;
    return { mod, releases: withParsed, latest };
  }

  /** Subscribe a user to a mod (optionally pinned to a version). */
  async subscribe(
    userId: string,
    gameId: string,
    key: string,
    pinnedVersion?: string,
  ): Promise<ModSubscriptionRecord> {
    const mod = await this.deps.prisma.mod.findUnique({
      where: { gameId_key: { gameId, key } },
    });
    if (!mod) {
      throw createError({ statusCode: 404, statusMessage: "Unknown mod" });
    }
    const existing = await this.deps.prisma.modSubscription.findUnique({
      where: { userId_modId: { userId, modId: mod.id } },
    });
    if (existing) {
      return this.deps.prisma.modSubscription.update({
        where: { userId_modId: { userId, modId: mod.id } },
        data: { pinnedVersion: pinnedVersion ?? null },
      });
    }
    return this.deps.prisma.modSubscription.create({
      data: {
        userId,
        modId: mod.id,
        ...(pinnedVersion ? { pinnedVersion } : {}),
      },
    });
  }

  /** Unsubscribe a user; returns whether a subscription existed. */
  async unsubscribe(
    userId: string,
    gameId: string,
    key: string,
  ): Promise<boolean> {
    const mod = await this.deps.prisma.mod.findUnique({
      where: { gameId_key: { gameId, key } },
    });
    if (!mod) return false;
    const existing = await this.deps.prisma.modSubscription.findUnique({
      where: { userId_modId: { userId, modId: mod.id } },
    });
    if (!existing) return false;
    await this.deps.prisma.modSubscription.delete({
      where: { userId_modId: { userId, modId: mod.id } },
    });
    return true;
  }

  async listSubscriptions(userId: string): Promise<ModSubscriptionView[]> {
    return this.deps.prisma.modSubscription.findMany({ where: { userId } });
  }
}
