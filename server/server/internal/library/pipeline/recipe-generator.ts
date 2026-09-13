import {
  DistributionType,
  type ClassificationResult,
  type PipelineRecipe,
  type PipelineStep,
} from "./types";

export function generatePipelineRecipe(
  classification: ClassificationResult,
  gameName: string,
): PipelineRecipe {
  const steps: PipelineStep[] = [];
  let targetExecutable =
    classification.detectedExecutables.find((e) => e.isPrimary)?.path ||
    classification.detectedExecutables[0]?.path ||
    `${gameName}.exe`;

  let setupCommand: string | undefined = undefined;
  let setupScriptWindows: string | undefined = undefined;
  let setupScriptLinux: string | undefined = undefined;

  switch (classification.type) {
    case DistributionType.SceneRelease: {
      setupCommand = "drop-pipeline-setup.bat";
      const primaryArchive = classification.primaryArchive || "*.rar";
      const crackGroup = classification.releaseGroup || "Crack";
      const isDirectIso = primaryArchive.toLowerCase().endsWith(".iso");

      if (isDirectIso) {
        // Standalone Scene ISO: extracting the image directly is the whole
        // setup. Running extract_rar on an ISO would just unpack it into the
        // temporary directory and then unpack the same image again into the
        // game folder.
        steps.push({
          id: "extract_iso",
          action: "extract_iso",
          params: {
            sourceGlob: primaryArchive,
            outputDir: ".",
          },
          description: `Extract Scene ISO disc image (${primaryArchive})`,
        });
      } else {
        steps.push({
          id: "extract_rar",
          action: "extract_rar",
          params: {
            input: primaryArchive,
            outputDir: ".drop_iso_tmp",
          },
          description: `Extract multi-part Scene archive (${primaryArchive})`,
        });

        steps.push({
          id: "extract_iso",
          action: "extract_iso",
          params: {
            sourceGlob: ".drop_iso_tmp/*.iso",
            outputDir: ".",
          },
          description: "Extract unpacked ISO disc image into root game folder",
        });
      }

      steps.push({
        id: "apply_crack",
        action: "apply_crack",
        params: {
          crackDir: crackGroup,
          targetDir: ".",
        },
        description: `Apply ${crackGroup} crack overlay`,
        optional: true,
      });

      steps.push({
        id: "cleanup",
        action: "cleanup",
        params: {
          targets: isDirectIso
            ? [primaryArchive]
            : [".drop_iso_tmp", "*.r0*", "*.r1*", "*.r2*", "*.r3*", "*.rar"],
        },
        description: isDirectIso
          ? "Remove the source ISO image"
          : "Remove intermediate ISO and multi-part RAR slices",
        optional: true,
      });

      const crackOverlayWindows = `for %%G in (RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack) do (
  if exist "%%G" (
    echo [Drop Pipeline] Applying crack from %%G...
    xcopy /s /e /y "%%G\\*" "."
  )
)`;

      const crackOverlayLinux = `for g in RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack; do
  if [ -d "$g" ]; then
    echo "[Drop Pipeline] Applying crack from $g..."
    cp -rf "$g"/* .
  fi
done`;

      if (isDirectIso) {
        setupScriptWindows = `@echo off
echo [Drop Pipeline] Extracting Scene Release ISO (${crackGroup})...
set SEVENZIP="7z"
if exist "%ProgramFiles%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles%\\7-Zip\\7z.exe"
if exist "%ProgramFiles(x86)%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\\7-Zip\\7z.exe"

%SEVENZIP% x -y "${primaryArchive}" -o.
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] ISO extraction failed.
  exit /b %ERRORLEVEL%
)

${crackOverlayWindows}

echo [Drop Pipeline] Scene release setup completed successfully!
exit /b 0
`;

        setupScriptLinux = `#!/bin/bash
set -e
echo "[Drop Pipeline] Extracting Scene Release ISO (${crackGroup})..."
7z x -y "${primaryArchive}" -o.
${crackOverlayLinux}
echo "[Drop Pipeline] Scene release setup completed successfully!"
`;
      } else {
        setupScriptWindows = `@echo off
echo [Drop Pipeline] Extracting Scene Release (${crackGroup})...
set SEVENZIP="7z"
if exist "%ProgramFiles%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles%\\7-Zip\\7z.exe"
if exist "%ProgramFiles(x86)%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\\7-Zip\\7z.exe"

echo [Drop Pipeline] Extracting archives to temporary directory...
%SEVENZIP% x -y "${primaryArchive}" -o.drop_iso_tmp
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Archive extraction failed.
  exit /b %ERRORLEVEL%
)

for %%F in (.drop_iso_tmp\\*.iso) do (
  echo [Drop Pipeline] Extracting ISO %%F...
  %SEVENZIP% x -y "%%F" -o.
)

${crackOverlayWindows}
if exist ".drop_iso_tmp" (
  for %%G in (RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack) do (
    if exist ".drop_iso_tmp\\%%G" (
      echo [Drop Pipeline] Applying crack from .drop_iso_tmp\\%%G...
      xcopy /s /e /y ".drop_iso_tmp\\%%G\\*" "."
    )
  )
)

if exist .drop_iso_tmp rmdir /s /q .drop_iso_tmp
echo [Drop Pipeline] Scene release setup completed successfully!
exit /b 0
`;

        setupScriptLinux = `#!/bin/bash
set -e
echo "[Drop Pipeline] Extracting Scene Release (${crackGroup})..."
mkdir -p .drop_iso_tmp
7z x -y "${primaryArchive}" -o.drop_iso_tmp
for iso in .drop_iso_tmp/*.iso; do
  if [ -f "$iso" ]; then
    echo "[Drop Pipeline] Extracting $iso..."
    7z x -y "$iso" -o.
  fi
done

${crackOverlayLinux}

for g in RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack; do
  if [ -d ".drop_iso_tmp/$g" ]; then
    echo "[Drop Pipeline] Applying crack from .drop_iso_tmp/$g..."
    cp -rf ".drop_iso_tmp/$g"/* .
  fi
done

rm -rf .drop_iso_tmp
echo "[Drop Pipeline] Scene release setup completed successfully!"
`;
      }
      break;
    }

    case DistributionType.GogInstaller: {
      setupCommand = "drop-pipeline-setup.bat";
      const setupExe = classification.installerExe || "setup.exe";

      steps.push({
        id: "innoextract",
        action: "innoextract",
        params: {
          installerExe: setupExe,
          outputDir: "app",
        },
        description: `Extract GOG Inno Setup installer (${setupExe})`,
      });

      steps.push({
        id: "cleanup",
        action: "cleanup",
        params: {
          targets: ["*.bin", setupExe],
        },
        description: "Remove GOG setup and data .bin files",
        optional: true,
      });

      // If extracted to app/, adjust targetExecutable if not already prefixed
      if (
        !targetExecutable.startsWith("app/") &&
        !targetExecutable.startsWith("app\\")
      ) {
        targetExecutable = `app/${targetExecutable}`;
      }

      setupScriptWindows = `@echo off
echo [Drop Pipeline] Installing GOG release (${setupExe})...
where innoextract >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [Drop Pipeline] Extracting with innoextract...
  innoextract -e -d app "${setupExe}"
  exit /b 0
)

echo [Drop Pipeline] Launching GOG silent installer...
start /wait "" "${setupExe}" /VERYSILENT /SUPPRESSMSGBOXES /DIR="%CD%\\app"
if %ERRORLEVEL% EQU 0 exit /b 0

echo [Drop Pipeline] Falling back to interactive setup...
start /wait "" "${setupExe}"
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo "[Drop Pipeline] Installing GOG release (${setupExe})..."
if command -v innoextract >/dev/null 2>&1; then
  echo "[Drop Pipeline] Extracting with innoextract..."
  innoextract -e -d app "${setupExe}"
  exit 0
else
  echo "[Drop Pipeline] Error: innoextract is required on Linux to extract GOG installers."
  exit 1
fi
`;
      break;
    }

    case DistributionType.FitGirlRepack:
    case DistributionType.KaOsRepack:
    case DistributionType.DodiRepack: {
      setupCommand = "drop-pipeline-setup.bat";
      const installerExe = classification.installerExe || "setup.exe";

      steps.push({
        id: "run_installer",
        action: "run_command",
        params: {
          command: installerExe,
          targetDir: ".",
        },
        description: `Run repack installer (${installerExe})`,
      });

      setupScriptWindows = `@echo off
echo [Drop Pipeline] Launching Repack Installer (${installerExe})...
start /wait "" "${installerExe}"
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo "[Drop Pipeline] Repack installation under Wine/Proton required for ${installerExe}"
wine "${installerExe}"
`;
      break;
    }

    case DistributionType.ArchiveBundle: {
      setupCommand = "drop-pipeline-setup.bat";
      const archive = classification.primaryArchive || "*.7z";

      steps.push({
        id: "extract_archive",
        action: "extract_archive",
        params: {
          archiveFile: archive,
          outputDir: ".",
        },
        description: `Extract compressed archive (${archive})`,
      });

      steps.push({
        id: "cleanup",
        action: "cleanup",
        params: {
          targets: [archive],
        },
        description: "Remove source archive",
        optional: true,
      });

      setupScriptWindows = `@echo off
echo [Drop Pipeline] Extracting Archive (${archive})...
set SEVENZIP="7z"
if exist "%ProgramFiles%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles%\\7-Zip\\7z.exe"
if exist "%ProgramFiles(x86)%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\\7-Zip\\7z.exe"

%SEVENZIP% x -y "${archive}" -o.
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo "[Drop Pipeline] Extracting Archive (${archive})..."
7z x -y "${archive}" -o.
exit 0
`;
      break;
    }

    case DistributionType.LoosePortable:
    default: {
      // No setup required for pre-extracted portable games
      break;
    }
  }

  return {
    version: "1",
    distributionType: classification.type,
    releaseGroup: classification.releaseGroup,
    steps,
    targetExecutable,
    setupCommand,
    setupScriptWindows,
    setupScriptLinux,
    recommendedPlatform: "windows",
  };
}
