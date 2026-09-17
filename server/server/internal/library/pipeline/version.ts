/**
 * Parses an implied version from release folder names, e.g.
 * `Grand.Theft.Auto.V.Enhanced.Update.v1.0.889.22-RUNE` -> `1.0.889.22`,
 * `James_Bond_007_Nightfire_Update_1.1-FLTDOX` -> `1.1`,
 * `A Short Hike_1.10.1_patched_(85628)` -> `1.10.1`,
 * `Metro Awakening v2026-01-14.7z` -> `2026.01.14`.
 *
 * Returns the most plausible dotted numeric run, or `undefined` when nothing
 * version-like is found.
 */
export function parseVersionHint(text: string): string | undefined {
  const dateMatch = /(\d{4}[-_.]\d{2}[-_.]\d{2})/.exec(text);
  if (dateMatch) {
    return dateMatch[1].replace(/[-_.]/g, ".");
  }

  const matches = [...text.matchAll(/(\d+(?:[._]\d+)+)(\D|$)/g)];
  const candidates: string[] = [];
  for (const match of matches) {
    if (dateMatch) continue;
    candidates.push(match[1]);
  }

  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

/**
 * Semver-ish comparison for multi-numeric version hints (dot-separated).
 * Missing segments compare as zero; a shorter run that is a strict prefix
 * loses (1.0 < 1.0.1). Returns a positive number when a > b.
 */
export function compareVersionHints(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const partsA = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const partsB = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa !== pb) return pa - pb;
  }
  return 0;
}
