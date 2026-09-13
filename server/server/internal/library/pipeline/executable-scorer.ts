import path from "node:path";
import type { ExecutableCandidate } from "./types";

const EXCLUDED_PATTERNS: RegExp[] = [
  /unins\d*\.exe$/i,
  /uninstall.*\.exe$/i,
  /setup.*\.exe$/i,
  /install.*\.exe$/i,
  /unitycrashhandler(32|64)?\.exe$/i,
  /crashreportclient.*\.exe$/i,
  /unrealcefsubprocess\.exe$/i,
  /vcredist.*\.exe$/i,
  /vc_redist.*\.exe$/i,
  /dxwebsetup\.exe$/i,
  /dotnet.*\.exe$/i,
  /dotnetfx.*\.exe$/i,
  /oalinst\.exe$/i,
  /physx.*\.exe$/i,
  /quicksfv\.exe$/i,
  /7z.*\.exe$/i,
  /autorun\.exe$/i,
  /verify.*\.exe$/i,
  /language.*setup.*\.exe$/i,
  /language.*selector.*\.exe$/i,
];

const EXCLUDED_DIR_PATTERNS: RegExp[] = [
  /[/\\]_commonredist[/\\]/i,
  /[/\\]redist[/\\]/i,
  /[/\\]directx[/\\]/i,
  /[/\\]support[/\\]/i,
  /[/\\]engine[/\\]binaries[/\\]dotnet[/\\]/i,
  /[/\\]dependencies[/\\]/i,
  /[/\\]crack[/\\]/i,
  /[/\\]rune[/\\]/i,
  /[/\\]tenoke[/\\]/i,
  /[/\\]codex[/\\]/i,
  /[/\\]goldberg/i,
];

/**
 * Normalizes text for string matching comparison
 */
function normalizeString(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Computes token overlap between game name and filename
 */
function tokenMatchScore(gameName: string, filename: string): number {
  const normGame = normalizeString(gameName);
  const normFile = normalizeString(
    path.basename(filename, path.extname(filename)),
  );

  if (!normGame || !normFile) return 0;

  if (normFile === normGame) return 50;
  if (normFile.includes(normGame) || normGame.includes(normFile)) return 35;

  const gameTokens = gameName
    .toLowerCase()
    .split(/[\s_\-.:]+/)
    .filter((t) => t.length > 2);
  const fileTokens = filename
    .toLowerCase()
    .split(/[\s_\-.:]+/)
    .filter((t) => t.length > 2);

  let matches = 0;
  for (const token of gameTokens) {
    if (fileTokens.some((ft) => ft.includes(token))) {
      matches++;
    }
  }

  if (gameTokens.length > 0) {
    return Math.round((matches / gameTokens.length) * 30);
  }

  return 0;
}

export function scoreExecutables(
  filePaths: string[],
  gameName: string,
): ExecutableCandidate[] {
  const candidates: ExecutableCandidate[] = [];

  for (const rawPath of filePaths) {
    const normPath = rawPath.replace(/\\/g, "/");
    const basename = path.basename(normPath);

    if (!basename.toLowerCase().endsWith(".exe")) {
      continue;
    }

    // Check against exclusions
    const isExcluded = EXCLUDED_PATTERNS.some((pattern) =>
      pattern.test(basename),
    );
    const isInExcludedDir = EXCLUDED_DIR_PATTERNS.some((pattern) =>
      pattern.test(normPath),
    );

    if (isExcluded || isInExcludedDir) {
      continue;
    }

    let score = 10;
    const reasons: string[] = ["Valid executable binary"];

    // Unreal Engine shipping binary detection
    if (/-win64-shipping\.exe$/i.test(basename)) {
      score += 45;
      reasons.push("Unreal Engine Win64 Shipping binary");
    }

    // Modern 64-bit architecture folders
    if (/[/\\](binaries[/\\]win64|bin[/\\]x64|x64)[/\\]/i.test(normPath)) {
      score += 30;
      reasons.push("Located in standard 64-bit binaries directory");
    } else if (/[/\\](binaries|bin)[/\\]/i.test(normPath)) {
      score += 15;
      reasons.push("Located in binaries directory");
    } else if (!normPath.includes("/")) {
      score += 20;
      reasons.push("Located directly in root game folder");
    }

    // Token match against game name
    const matchScore = tokenMatchScore(gameName, basename);
    if (matchScore > 0) {
      score += matchScore;
      reasons.push(`Matches game name tokens (+${matchScore})`);
    }

    // Penalize generic launchers slightly compared to direct game exes
    if (/launcher\.exe$/i.test(basename)) {
      score -= 5;
      reasons.push("Generic launcher binary (-5)");
    }

    // Penalize deep nesting
    const depth = normPath.split("/").length - 1;
    if (depth > 4) {
      score -= 10;
      reasons.push("Deeply nested path (-10)");
    }

    candidates.push({
      path: normPath,
      score,
      reasons,
      isPrimary: false,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    candidates[0].isPrimary = true;
  }

  return candidates;
}
