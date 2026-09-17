import type { ExecutableCandidate } from "./types";
import { scoreExecutables } from "./executable-scorer";

export interface InstalledDirScanResult {
  candidates: ExecutableCandidate[];
  scannedCount: number;
  skippedCount: number;
}

/**
 * Post-install executable resolution. After an installer-based setup extracts
 * the game, the client re-scans the install directory and sends only the
 * discovered `.exe` paths; this mirrors the import-time scorer to pick the
 * launch target that did not exist when the recipe was generated.
 */
export function scanInstalledDir(
  relativeFiles: string[],
  gameName: string,
): InstalledDirScanResult {
  const scannedCount = relativeFiles.length;
  const candidates = scoreExecutables(relativeFiles, gameName);
  return {
    candidates,
    scannedCount,
    skippedCount: scannedCount - candidates.length,
  };
}
