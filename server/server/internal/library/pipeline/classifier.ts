import fs from "node:fs";
import path from "node:path";
import { DistributionType, type ClassificationResult } from "./types";
import { scoreExecutables } from "./executable-scorer";

const SCENE_GROUPS = [
  "RUNE",
  "TENOKE",
  "CODEX",
  "SKIDROW",
  "PLAZA",
  "FLT",
  "DEViANCE",
  "RELOADED",
  "HOODLUM",
  "FAIRLIGHT",
  "DOGE",
  "EMPRESS",
  "PARADiGM",
  "PROPHET",
  "TiNYiSO",
  "ALiAS",
  "BAT",
  "Razor1911",
  "FLTDOX",
  "RazorDOX",
  "SiMPLEX",
  "DARKSiDERS",
  "DINOByTES",
  "Chrono",
  "Unleashed",
  "HI2U",
];

const SCENE_GROUP_REGEX = new RegExp(
  `[-_. ](${SCENE_GROUPS.join("|")})([-_.]|$)`,
  "i",
);

const ARCHIVE_EXTENSIONS = [".7z", ".zip", ".rar", ".tar", ".gz"];

interface ClassificationContext {
  gameName: string;
  fileList: string[];
  allFilesWithSubdirs: string[];
  folderName: string;
  lowerFolder: string;
  lowerFiles: string[];
  releaseGroup: string | undefined;
  nfoFile: string | undefined;
  rars: string[];
  hasSfvs: boolean;
  hasIso: boolean;
}

type DistributionClassifier = (
  ctx: ClassificationContext,
) => ClassificationResult | undefined;

function resolveFileList(dirPath: string, knownFiles?: string[]): string[] {
  if (knownFiles && knownFiles.length > 0) {
    return knownFiles;
  }
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  try {
    const stats = fs.statSync(dirPath);
    return stats.isDirectory()
      ? fs.readdirSync(dirPath)
      : [path.basename(dirPath)];
  } catch {
    return [];
  }
}

/** Lists shallow subdirectory entries (e.g. CD1, CD2, Disc1, DVD1). */
function collectFilesWithSubdirs(
  dirPath: string,
  fileList: string[],
): string[] {
  const allFilesWithSubdirs = [...fileList];
  if (!fs.existsSync(dirPath)) {
    return allFilesWithSubdirs;
  }
  try {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return allFilesWithSubdirs;
    }
    for (const entry of fileList) {
      const subPath = path.join(dirPath, entry);
      try {
        if (fs.statSync(subPath).isDirectory()) {
          const subEntries = fs.readdirSync(subPath);
          for (const sub of subEntries) {
            allFilesWithSubdirs.push(`${entry}/${sub}`);
          }
        }
      } catch {
        // Ignore unreadable subdirectories
      }
    }
  } catch {
    // Ignore unreadable directory
  }
  return allFilesWithSubdirs;
}

/** Detects the scene group from the folder name or a sibling NFO. */
function resolveReleaseGroup(
  fileList: string[],
  folderName: string,
): { releaseGroup: string | undefined; nfoFile: string | undefined } {
  let releaseGroup: string | undefined;
  const folderMatch = folderName.match(SCENE_GROUP_REGEX);
  if (folderMatch) {
    releaseGroup = folderMatch[1].toUpperCase();
  }

  const nfoFile = fileList.find((f) => f.toLowerCase().endsWith(".nfo"));
  if (!releaseGroup && nfoFile) {
    const nfoMatch = nfoFile.match(SCENE_GROUP_REGEX);
    if (nfoMatch) {
      releaseGroup = nfoMatch[1].toUpperCase();
    }
  }

  return { releaseGroup, nfoFile };
}

function isRarPart(file: string): boolean {
  const lower = file.toLowerCase();
  return (
    lower.endsWith(".rar") ||
    /\.r\d{2}$/i.test(lower) ||
    /\.part\d+\.rar$/i.test(lower)
  );
}

function detectUpdateRelease(fileList: string[], folderName: string): boolean {
  return (
    /([-_.]update|patch)[-_.]/i.test(folderName) ||
    fileList.some((f) => /([-_.]update|patch)[-_.]/i.test(f))
  );
}

function baseResult(
  ctx: ClassificationContext,
  type: DistributionType,
  confidence: number,
  summary: string,
): ClassificationResult {
  return {
    type,
    confidence,
    detectedExecutables: scoreExecutables(ctx.fileList, ctx.gameName),
    summary,
  };
}

const classifyPatchUpdate: DistributionClassifier = (ctx) => {
  const isUpdate = detectUpdateRelease(ctx.fileList, ctx.folderName);
  if (!isUpdate || (ctx.rars.length === 0 && !ctx.releaseGroup)) {
    return undefined;
  }
  return {
    ...baseResult(
      ctx,
      DistributionType.PatchUpdate,
      0.95,
      `Game patch/update release (${ctx.releaseGroup ?? "Unknown Group"})`,
    ),
    releaseGroup: ctx.releaseGroup,
    nfoPath: ctx.nfoFile,
    multipartRars: ctx.rars,
  };
};

const classifySceneRar: DistributionClassifier = (ctx) => {
  const isMultipartRar =
    ctx.rars.length > 1 ||
    (ctx.rars.length === 1 &&
      (ctx.hasSfvs || !!ctx.releaseGroup || ctx.hasIso));
  if (!isMultipartRar) {
    return undefined;
  }
  const primaryRar =
    ctx.fileList.find((f) => /\.part0*1\.rar$/i.test(f)) ||
    ctx.fileList.find((f) => f.toLowerCase().endsWith(".rar")) ||
    ctx.rars[0];

  return {
    ...baseResult(
      ctx,
      DistributionType.SceneRelease,
      0.95,
      `Scene release in multi-part RAR archives (${ctx.releaseGroup ?? "Scene"})`,
    ),
    releaseGroup: ctx.releaseGroup,
    nfoPath: ctx.nfoFile,
    primaryArchive: primaryRar,
    multipartRars: ctx.rars,
  };
};

const classifyDirectIso: DistributionClassifier = (ctx) => {
  if (!ctx.hasIso || (!ctx.releaseGroup && !ctx.hasSfvs && !ctx.nfoFile)) {
    return undefined;
  }
  const isoFile = ctx.fileList.find((f) => f.toLowerCase().endsWith(".iso"));
  return {
    ...baseResult(
      ctx,
      DistributionType.SceneRelease,
      0.9,
      `Scene release standalone ISO disc image (${ctx.releaseGroup ?? "Scene"})`,
    ),
    releaseGroup: ctx.releaseGroup,
    nfoPath: ctx.nfoFile,
    primaryArchive: isoFile,
  };
};

const classifyFitGirl: DistributionClassifier = (ctx) => {
  const hasFitGirlSignature =
    ctx.lowerFolder.includes("[fitgirl repack]") ||
    ctx.lowerFolder.includes("fitgirl") ||
    ctx.fileList.some((f) => /^fg-.*\.bin$/i.test(f)) ||
    (ctx.lowerFiles.includes("setup.exe") &&
      ctx.lowerFiles.some((f) => f.includes("verify bin files")));
  if (!hasFitGirlSignature) {
    return undefined;
  }
  const setupExe =
    ctx.fileList.find((f) => f.toLowerCase() === "setup.exe") ?? "setup.exe";
  const binChunks = ctx.fileList.filter((f) => /^fg-.*\.bin$/i.test(f));

  return {
    ...baseResult(
      ctx,
      DistributionType.FitGirlRepack,
      0.99,
      `FitGirl Repack installer (${binChunks.length} data bins)`,
    ),
    releaseGroup: "FitGirl",
    installerExe: setupExe,
    binChunks,
  };
};

const classifyKaOs: DistributionClassifier = (ctx) => {
  const hasKaosSignature =
    ctx.lowerFolder.includes("repack-kaos") ||
    ctx.lowerFolder.includes("[kaos repack]") ||
    ctx.fileList.some((f) => /^kaos-.*\.bin$/i.test(f)) ||
    ctx.fileList.some((f) => f.toLowerCase() === "kaos.nfo");
  if (!hasKaosSignature) {
    return undefined;
  }
  const installExe =
    ctx.fileList.find((f) => f.toLowerCase() === "install.exe") ??
    ctx.fileList.find((f) => f.toLowerCase() === "setup.exe") ??
    "Install.exe";
  const binChunks = ctx.fileList.filter((f) => /^kaos-.*\.bin$/i.test(f));

  return {
    ...baseResult(
      ctx,
      DistributionType.KaOsRepack,
      0.99,
      `KaOs Krew Repack installer (${binChunks.length} data bins)`,
    ),
    releaseGroup: "KaOs",
    installerExe: installExe,
    binChunks,
  };
};

const classifyDodi: DistributionClassifier = (ctx) => {
  const hasDodiSignature =
    ctx.lowerFolder.includes("[dodi repack]") ||
    ctx.lowerFolder.includes("dodi") ||
    ctx.fileList.some((f) => /^data\d+\.doi$/i.test(f));
  if (!hasDodiSignature) {
    return undefined;
  }
  const setupExe =
    ctx.fileList.find((f) => f.toLowerCase() === "setup.exe") ?? "setup.exe";

  return {
    ...baseResult(
      ctx,
      DistributionType.DodiRepack,
      0.95,
      "DODI Repack installer",
    ),
    releaseGroup: "DODI",
    installerExe: setupExe,
  };
};

const classifyGog: DistributionClassifier = (ctx) => {
  const gogSetupExe = ctx.fileList.find(
    (f) =>
      f.toLowerCase().startsWith("setup_") && f.toLowerCase().endsWith(".exe"),
  );
  const hasGogBin = ctx.fileList.some((f) => /^setup_.*-\d+\.bin$/i.test(f));
  const hasGogInName = ctx.lowerFolder.includes("gog");
  if (!gogSetupExe && !(hasGogBin && hasGogInName)) {
    return undefined;
  }
  const binChunks = ctx.fileList.filter((f) => /^setup_.*-\d+\.bin$/i.test(f));

  return {
    ...baseResult(
      ctx,
      DistributionType.GogInstaller,
      0.98,
      `GOG Offline Installer (${binChunks.length} data bins)`,
    ),
    releaseGroup: "GOG",
    installerExe: gogSetupExe,
    binChunks,
  };
};

const classifyArchiveBundle: DistributionClassifier = (ctx) => {
  const archives = ctx.fileList.filter((f) =>
    ARCHIVE_EXTENSIONS.includes(path.extname(f).toLowerCase()),
  );
  if (archives.length === 0 || ctx.fileList.length > archives.length + 3) {
    return undefined;
  }

  return {
    ...baseResult(
      ctx,
      DistributionType.ArchiveBundle,
      0.9,
      `Compressed archive bundle (${archives.map((a) => path.extname(a)).join(", ")})`,
    ),
    primaryArchive: archives[0],
  };
};

const classifyLoosePortable: DistributionClassifier = (ctx) => {
  const executableCandidates = scoreExecutables(ctx.fileList, ctx.gameName);
  if (executableCandidates.length === 0) {
    return undefined;
  }
  return {
    type: DistributionType.LoosePortable,
    confidence: 0.85,
    detectedExecutables: executableCandidates,
    summary: `Loose portable game directory with ${executableCandidates.length} candidate executable(s)`,
  };
};

/**
 * Classification runs in priority order; the first matching classifier wins.
 * Keeping each format in its own function keeps the branching shallow and the
 * rules independently testable.
 */
const CLASSIFIERS: DistributionClassifier[] = [
  classifyPatchUpdate,
  classifySceneRar,
  classifyDirectIso,
  classifyFitGirl,
  classifyKaOs,
  classifyDodi,
  classifyGog,
  classifyArchiveBundle,
  classifyLoosePortable,
];

export function classifyDistribution(
  dirPath: string,
  gameName: string,
  knownFiles?: string[],
): ClassificationResult {
  const fileList = resolveFileList(dirPath, knownFiles);
  const allFilesWithSubdirs = collectFilesWithSubdirs(dirPath, fileList);
  const folderName = path.basename(dirPath);
  const lowerFolder = folderName.toLowerCase();
  const lowerFiles = fileList.map((f) => f.toLowerCase());
  const { releaseGroup, nfoFile } = resolveReleaseGroup(fileList, folderName);

  const ctx: ClassificationContext = {
    gameName,
    fileList,
    allFilesWithSubdirs,
    folderName,
    lowerFolder,
    lowerFiles,
    releaseGroup,
    nfoFile,
    rars: allFilesWithSubdirs.filter(isRarPart),
    hasSfvs: allFilesWithSubdirs.some((f) => f.toLowerCase().endsWith(".sfv")),
    hasIso: allFilesWithSubdirs.some((f) => f.toLowerCase().endsWith(".iso")),
  };

  for (const classify of CLASSIFIERS) {
    const result = classify(ctx);
    if (result) return result;
  }

  return {
    type: DistributionType.Unknown,
    confidence: 0.1,
    detectedExecutables: [],
    summary: "Unknown distribution format",
  };
}
