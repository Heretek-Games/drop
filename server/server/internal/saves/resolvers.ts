import type {
  CloudSavePathResolver,
  CloudSavePattern,
  GameInstallContext,
} from "../plugins/types";

export interface ResolvedCloudSavePattern extends CloudSavePattern {
  resolverId: string;
}

/**
 * Asks every registered `CloudSaveProvider` SPI resolver for save-path patterns
 * for a game, tagging each result with the resolver that supplied it. A failing
 * resolver is skipped rather than failing the whole lookup.
 */
export async function resolveCloudSavePatterns(
  resolvers: CloudSavePathResolver[],
  context: GameInstallContext,
): Promise<ResolvedCloudSavePattern[]> {
  const resolved = await Promise.all(
    resolvers.map(async (resolver) => {
      try {
        const patterns = await resolver.resolveSavePaths(context);
        return patterns.map((pattern) => ({
          ...pattern,
          resolverId: resolver.id,
        }));
      } catch {
        return [];
      }
    }),
  );

  return resolved.flat();
}
