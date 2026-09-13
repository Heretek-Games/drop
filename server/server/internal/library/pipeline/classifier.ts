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

export function classifyDistribution(
  dirPath: string,
  gameName: string,
  knownFiles?: string[],
): ClassificationResult {
  let fileList: string[] = [];

  if (knownFiles && knownFiles.length > 0) {
    fileList = knownFiles;
  } else if (fs.existsSync(dirPath)) {
    try {
      const stats = fs.statSync(dirPath);
      if (stats.isDirectory()) {
        fileList = fs.readdirSync(dirPath);
      } else {
        fileList = [path.basename(dirPath)];
      }
    } catch {
      fileList = [];
    }
  }

  const folderName = path.basename(dirPath);
  const lowerFolder = folderName.toLowerCase();
  const lowerFiles = fileList.map((f) => f.toLowerCase());

  // Detect Scene Group from folder or NFO
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

  // Also scan shallow subdirectories (e.g. CD1, CD2, Disc1, DVD1)
  const allFilesWithSubdirs = [...fileList];
  if (fs.existsSync(dirPath)) {
    try {
      const stats = fs.statSync(dirPath);
      if (stats.isDirectory()) {
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
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  // Check for multi-part scene RARs
  const rars = allFilesWithSubdirs.filter((f) => {
    const l = f.toLowerCase();
    return (
      l.endsWith(".rar") || /\.r\d{2}$/i.test(l) || /\.part\d+\.rar$/i.test(l)
    );
  });

  const hasSfvs = allFilesWithSubdirs.some((f) =>
    f.toLowerCase().endsWith(".sfv"),
  );
  const hasIso = allFilesWithSubdirs.some((f) =>
    f.toLowerCase().endsWith(".iso"),
  );

  // Check for updates
  const isUpdate =
    /([-_.]update|patch)[-_.]/i.test(folderName) ||
    fileList.some((f) => /([-_.]update|patch)[-_.]/i.test(f));

  if (isUpdate && (rars.length > 0 || releaseGroup)) {
    return {
      type: DistributionType.PatchUpdate,
      confidence: 0.95,
      releaseGroup,
      nfoPath: nfoFile,
      multipartRars: rars,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `Game patch/update release (${releaseGroup ?? "Unknown Group"})`,
    };
  }

  // 1. Scene Multi-part RAR / ISO Release
  if (
    rars.length > 1 ||
    (rars.length === 1 && (hasSfvs || releaseGroup || hasIso))
  ) {
    const primaryRar =
      fileList.find((f) => /\.part0*1\.rar$/i.test(f)) ||
      fileList.find((f) => f.toLowerCase().endsWith(".rar")) ||
      rars[0];

    return {
      type: DistributionType.SceneRelease,
      confidence: 0.95,
      releaseGroup,
      nfoPath: nfoFile,
      primaryArchive: primaryRar,
      multipartRars: rars,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `Scene release in multi-part RAR archives (${releaseGroup ?? "Scene"})`,
    };
  }

  // 2. Direct Scene ISO
  if (hasIso && (releaseGroup || hasSfvs || nfoFile)) {
    const isoFile = fileList.find((f) => f.toLowerCase().endsWith(".iso"));
    return {
      type: DistributionType.SceneRelease,
      confidence: 0.9,
      releaseGroup,
      nfoPath: nfoFile,
      primaryArchive: isoFile,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `Scene release standalone ISO disc image (${releaseGroup ?? "Scene"})`,
    };
  }

  // 3. FitGirl Repack
  const hasFitGirlSignature =
    lowerFolder.includes("[fitgirl repack]") ||
    lowerFolder.includes("fitgirl") ||
    fileList.some((f) => /^fg-.*\.bin$/i.test(f)) ||
    (lowerFiles.includes("setup.exe") &&
      lowerFiles.some((f) => f.includes("verify bin files")));

  if (hasFitGirlSignature) {
    const setupExe =
      fileList.find((f) => f.toLowerCase() === "setup.exe") ?? "setup.exe";
    const binChunks = fileList.filter((f) => /^fg-.*\.bin$/i.test(f));

    return {
      type: DistributionType.FitGirlRepack,
      confidence: 0.99,
      releaseGroup: "FitGirl",
      installerExe: setupExe,
      binChunks,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `FitGirl Repack installer (${binChunks.length} data bins)`,
    };
  }

  // 4. KaOs Repack
  const hasKaosSignature =
    lowerFolder.includes("repack-kaos") ||
    lowerFolder.includes("[kaos repack]") ||
    fileList.some((f) => /^kaos-.*\.bin$/i.test(f)) ||
    fileList.some((f) => f.toLowerCase() === "kaos.nfo");

  if (hasKaosSignature) {
    const installExe =
      fileList.find((f) => f.toLowerCase() === "install.exe") ??
      fileList.find((f) => f.toLowerCase() === "setup.exe") ??
      "Install.exe";
    const binChunks = fileList.filter((f) => /^kaos-.*\.bin$/i.test(f));

    return {
      type: DistributionType.KaOsRepack,
      confidence: 0.99,
      releaseGroup: "KaOs",
      installerExe: installExe,
      binChunks,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `KaOs Krew Repack installer (${binChunks.length} data bins)`,
    };
  }

  // 5. DODI Repack
  const hasDodiSignature =
    lowerFolder.includes("[dodi repack]") ||
    lowerFolder.includes("dodi") ||
    fileList.some((f) => /^data\d+\.doi$/i.test(f));

  if (hasDodiSignature) {
    const setupExe =
      fileList.find((f) => f.toLowerCase() === "setup.exe") ?? "setup.exe";
    return {
      type: DistributionType.DodiRepack,
      confidence: 0.95,
      releaseGroup: "DODI",
      installerExe: setupExe,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: "DODI Repack installer",
    };
  }

  // 6. GOG Offline Multi-bin Installer
  const gogSetupExe = fileList.find(
    (f) =>
      f.toLowerCase().startsWith("setup_") && f.toLowerCase().endsWith(".exe"),
  );
  const hasGogBin = fileList.some((f) => /^setup_.*-\d+\.bin$/i.test(f));
  const hasGogInName = lowerFolder.includes("gog");

  if (gogSetupExe || (hasGogBin && hasGogInName)) {
    const binChunks = fileList.filter((f) => /^setup_.*-\d+\.bin$/i.test(f));

    return {
      type: DistributionType.GogInstaller,
      confidence: 0.98,
      releaseGroup: "GOG",
      installerExe: gogSetupExe,
      binChunks,
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `GOG Offline Installer (${binChunks.length} data bins)`,
    };
  }

  // 7. Standalone Compressed Archive Bundle (.7z, .zip, .rar)
  const archives = fileList.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return [".7z", ".zip", ".rar", ".tar", ".gz"].includes(ext);
  });

  if (archives.length > 0 && fileList.length <= archives.length + 3) {
    return {
      type: DistributionType.ArchiveBundle,
      confidence: 0.9,
      primaryArchive: archives[0],
      detectedExecutables: scoreExecutables(fileList, gameName),
      summary: `Compressed archive bundle (${archives.map((a) => path.extname(a)).join(", ")})`,
    };
  }

  // 8. Loose Portable Game
  const executableCandidates = scoreExecutables(fileList, gameName);
  if (executableCandidates.length > 0) {
    return {
      type: DistributionType.LoosePortable,
      confidence: 0.85,
      detectedExecutables: executableCandidates,
      summary: `Loose portable game directory with ${executableCandidates.length} candidate executable(s)`,
    };
  }

  return {
    type: DistributionType.Unknown,
    confidence: 0.1,
    detectedExecutables: [],
    summary: "Unknown distribution format",
  };
}
