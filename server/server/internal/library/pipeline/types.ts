export type Platform =
  "windows" | "linux" | "macos" | "Windows" | "Linux" | "macOS";

export enum DistributionType {
  SceneRelease = "SceneRelease", // Multi-part RARs (.r00-.r99, .part01.rar) with ISO and crack
  GogInstaller = "GogInstaller", // GOG Inno Setup multi-bin installers (setup_*.exe, -1.bin)
  FitGirlRepack = "FitGirlRepack", // FitGirl Inno Setup + FreeArc repacks (fg-*.bin)
  KaOsRepack = "KaOsRepack", // KaOs repacks (Install.exe, KaOs-*.bin)
  DodiRepack = "DodiRepack", // DODI repacks
  ArchiveBundle = "ArchiveBundle", // Single or multi compressed archive (.7z, .zip, .rar)
  LoosePortable = "LoosePortable", // Unpacked, pre-cracked portable game folder
  PatchUpdate = "PatchUpdate", // Standalone update or delta patch
  Unknown = "Unknown",
}

export type PipelineStepAction =
  | "extract_rar"
  | "extract_iso"
  | "extract_archive"
  | "innoextract"
  | "apply_crack"
  | "cleanup"
  | "run_command";

export interface PipelineStep {
  id: string;
  action: PipelineStepAction;
  params: Record<string, string | number | boolean | string[]>;
  description: string;
  optional?: boolean;
}

export interface ExecutableCandidate {
  path: string;
  score: number;
  reasons: string[];
  isPrimary: boolean;
}

export interface ClassificationResult {
  type: DistributionType;
  confidence: number;
  releaseGroup?: string;
  nfoPath?: string;
  primaryArchive?: string;
  multipartRars?: string[];
  installerExe?: string;
  updateDir?: string;
  binChunks?: string[];
  crackDir?: string;
  detectedExecutables: ExecutableCandidate[];
  summary: string;
}

export interface PipelineRecipe {
  version: "1";
  distributionType: DistributionType;
  releaseGroup?: string;
  steps: PipelineStep[];
  targetExecutable: string;
  targetArgs?: string[];
  setupCommand?: string;
  setupScriptWindows?: string;
  setupScriptLinux?: string;
  recommendedPlatform: Platform;
}
