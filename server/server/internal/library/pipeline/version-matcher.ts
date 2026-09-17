import { compareVersionHints, parseVersionHint } from "./version";

export interface BaseVersionCandidate {
  versionId: string;
  versionPath: string | null;
  delta: boolean;
}

export interface MatchedBaseVersion {
  versionId: string;
  versionPath: string | null;
  versionHint: string | undefined;
}

/**
 * Picks the base game version a standalone update/patch applies to.
 *
 * Strategy: among the game's non-delta versions, prefer the one whose parsed
 * version hint is the greatest hint smaller than the patch's own hint. This
 * matches the Steam-like model of "newest installable build before the patch".
 * Ties fall back to the highest versionIndex (provided as ordering in the
 * caller), and when no hints are parseable at all the newest non-delta version
 * wins (given as version id ordering in `newestFirst`).
 */
export function matchPatchToBaseVersion(
  patchHint: string | undefined,
  baseVersions: BaseVersionCandidate[],
  newestFirst: string[],
): MatchedBaseVersion | undefined {
  const bases = baseVersions.filter(
    (v) => !v.delta && (v.versionPath !== null || newestFirst.length > 0),
  );
  if (bases.length === 0) return undefined;

  const hinted = bases
    .map((v) => ({ base: v, hint: parseVersionHint(v.versionPath ?? "") }))
    .filter((v) => v.hint !== undefined);

  if (
    patchHint !== undefined &&
    hinted.some(({ hint }) => hint !== undefined)
  ) {
    const predecessors = hinted
      .filter(({ hint }) => {
        if (typeof hint !== "string") return false;
        return compareVersionHints(patchHint, hint) > 0;
      })
      .sort((a, b) => compareVersionHints(b.hint, a.hint));

    if (predecessors.length > 0) {
      return {
        versionId: predecessors[0].base.versionId,
        versionPath: predecessors[0].base.versionPath,
        versionHint: predecessors[0].hint,
      };
    }
  }

  const fallbackId = newestFirst.find((id) =>
    bases.some((v) => v.versionId === id),
  );
  const fallback =
    fallbackId !== undefined
      ? bases.find((v) => v.versionId === fallbackId)
      : undefined;
  if (!fallback) return undefined;
  return {
    versionId: fallback.versionId,
    versionPath: fallback.versionPath,
    versionHint: parseVersionHint(fallback.versionPath ?? ""),
  };
}
