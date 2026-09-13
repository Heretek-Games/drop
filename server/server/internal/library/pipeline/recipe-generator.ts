import {
  DistributionType,
  type ClassificationResult,
  type PipelineRecipe,
  type PipelineStep,
} from "./types";

const ESCAPED_SINGLE_QUOTE = String.raw`'\''`;

/**
 * Quotes a value as a single-quoted POSIX shell word. Single quotes are
 * escaped by closing the quote, emitting an escaped quote, and reopening it.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", ESCAPED_SINGLE_QUOTE)}'`;
}

/**
 * Escapes text embedded in a Windows batch script. `%` expands even inside
 * double quotes; `&`, `|`, `<`, `>` and `^` are command operators. Quotes and
 * control characters cannot be escaped reliably and are rejected.
 */
export function batchEcho(value: string): string {
  if (/["\r\n\0]/.test(value)) {
    throw new Error(`unsafe value for a Windows batch script: ${value}`);
  }
  return value.replaceAll("%", "%%").replace(/[&|<>^]/g, "^$&");
}

/**
 * Escapes a value used as a Windows batch command argument. `%` expands even
 * inside double quotes; quotes and control characters are rejected.
 */
export function batchQuote(value: string): string {
  if (/["\r\n\0]/.test(value)) {
    throw new Error(`unsafe value for a Windows batch script: ${value}`);
  }
  return `"${value.replaceAll("%", "%%")}"`;
}

/**
 * Embeds a pipeline recipe into a droplet manifest.
 *
 * Local manifests arrive from torrential as a JSON string, while depot
 * manifests are already parsed objects. Spread the parsed object so the
 * recipe survives for both shapes.
 */
export function attachRecipeToManifest(
  manifest: unknown,
  recipe: PipelineRecipe,
): object {
  const parsed = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "cannot embed a pipeline recipe in a non-object droplet manifest",
    );
  }
  return { ...parsed, recipe };
}

export function generatePipelineRecipe(
  classification: ClassificationResult,
  _gameName: string,
): PipelineRecipe {
  // The recipe must not invent a name; `_gameName` is retained for call-site
  // compatibility only.
  const steps: PipelineStep[] = [];
  // Never fabricate a launch target: an invented "<game>.exe" would produce a
  // Play button for a file that does not exist. An empty target means the
  // scorer found nothing and the caller must not add a launch option.
  let targetExecutable =
    classification.detectedExecutables.find((e) => e.isPrimary)?.path ||
    classification.detectedExecutables[0]?.path ||
    "";

  let setupCommand: string | undefined = undefined;
  let setupScriptWindows: string | undefined = undefined;
  let setupScriptLinux: string | undefined = undefined;

  switch (classification.type) {
    case DistributionType.SceneRelease: {
      setupCommand = "drop-pipeline-setup.bat";
      const primaryArchive = classification.primaryArchive || "*.rar";
      const crackGroup = classification.releaseGroup || "Crack";
      const isDirectIso = primaryArchive.toLowerCase().endsWith(".iso");
      const isoLabel = `[Drop Pipeline] Extracting Scene Release ISO (${crackGroup})...`;
      const archiveLabel = `[Drop Pipeline] Extracting Scene Release (${crackGroup})...`;

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
        steps.push(
          {
            id: "extract_rar",
            action: "extract_rar",
            params: {
              input: primaryArchive,
              outputDir: ".drop_iso_tmp",
            },
            description: `Extract multi-part Scene archive (${primaryArchive})`,
          },
          {
            id: "extract_iso",
            action: "extract_iso",
            params: {
              sourceGlob: ".drop_iso_tmp/*.iso",
              outputDir: ".",
            },
            description:
              "Extract unpacked ISO disc image into root game folder",
          },
        );
      }

      steps.push(
        {
          id: "apply_crack",
          action: "apply_crack",
          params: {
            crackDir: crackGroup,
            targetDir: ".",
          },
          description: `Apply ${crackGroup} crack overlay`,
          optional: true,
        },
        {
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
        },
      );

      const crackOverlayWindows = String.raw`for %%G in (RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack) do (
  if exist "%%G" (
    echo [Drop Pipeline] Applying crack from %%G...
    xcopy /s /e /y "%%G\*" "."
  )
)`;

      const crackOverlayLinux = `for g in RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack; do
  if [ -d "$g" ]; then
    echo "[Drop Pipeline] Applying crack from $g..."
    cp -rf "$g"/* .
  fi
done`;

      if (isDirectIso) {
        setupScriptWindows = String.raw`@echo off
echo ${batchEcho(isoLabel)}
set SEVENZIP="7z"
if exist "%ProgramFiles%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles%\7-Zip\7z.exe"
if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\7-Zip\7z.exe"

%SEVENZIP% x -y ${batchQuote(primaryArchive)} -o.
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
echo ${shellQuote(isoLabel)}
7z x -y ${shellQuote(primaryArchive)} -o.
${crackOverlayLinux}
echo "[Drop Pipeline] Scene release setup completed successfully!"
`;
      } else {
        setupScriptWindows = String.raw`@echo off
echo ${batchEcho(archiveLabel)}
set SEVENZIP="7z"
if exist "%ProgramFiles%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles%\7-Zip\7z.exe"
if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\7-Zip\7z.exe"

echo [Drop Pipeline] Extracting archives to temporary directory...
%SEVENZIP% x -y ${batchQuote(primaryArchive)} -o.drop_iso_tmp
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Archive extraction failed.
  exit /b %ERRORLEVEL%
)

for %%F in (.drop_iso_tmp\*.iso) do (
  echo [Drop Pipeline] Extracting ISO %%F...
  %SEVENZIP% x -y "%%F" -o.
)

${crackOverlayWindows}
if exist ".drop_iso_tmp" (
  for %%G in (RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack) do (
    if exist ".drop_iso_tmp\%%G" (
      echo [Drop Pipeline] Applying crack from .drop_iso_tmp\%%G...
      xcopy /s /e /y ".drop_iso_tmp\%%G\*" "."
    )
  )
)

if exist .drop_iso_tmp rmdir /s /q .drop_iso_tmp
echo [Drop Pipeline] Scene release setup completed successfully!
exit /b 0
`;

        setupScriptLinux = `#!/bin/bash
set -e
echo ${shellQuote(archiveLabel)}
mkdir -p .drop_iso_tmp
7z x -y ${shellQuote(primaryArchive)} -o.drop_iso_tmp
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

      steps.push(
        {
          id: "innoextract",
          action: "innoextract",
          params: {
            installerExe: setupExe,
            outputDir: "app",
          },
          description: `Extract GOG Inno Setup installer (${setupExe})`,
        },
        {
          id: "cleanup",
          action: "cleanup",
          params: {
            targets: ["*.bin", setupExe],
          },
          description: "Remove GOG setup and data .bin files",
          optional: true,
        },
      );

      // If extracted to app/, adjust targetExecutable if not already prefixed
      if (
        targetExecutable &&
        !targetExecutable.startsWith("app/") &&
        !targetExecutable.startsWith("app\\")
      ) {
        targetExecutable = `app/${targetExecutable}`;
      }

      setupScriptWindows = String.raw`@echo off
echo ${batchEcho(`[Drop Pipeline] Installing GOG release (${setupExe})...`)}
where innoextract >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [Drop Pipeline] Extracting with innoextract...
  innoextract -e -d app ${batchQuote(setupExe)}
  exit /b 0
)

echo [Drop Pipeline] Launching GOG silent installer...
start /wait "" ${batchQuote(setupExe)} /VERYSILENT /SUPPRESSMSGBOXES /DIR="%CD%\app"
if %ERRORLEVEL% EQU 0 exit /b 0

echo [Drop Pipeline] Falling back to interactive setup...
start /wait "" ${batchQuote(setupExe)}
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo ${shellQuote(`[Drop Pipeline] Installing GOG release (${setupExe})...`)}
if command -v innoextract >/dev/null 2>&1; then
  echo "[Drop Pipeline] Extracting with innoextract..."
  innoextract -e -d app ${shellQuote(setupExe)}
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
echo ${batchEcho(`[Drop Pipeline] Launching Repack Installer (${installerExe})...`)}
start /wait "" ${batchQuote(installerExe)}
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo ${shellQuote(`[Drop Pipeline] Repack installation under Wine/Proton required for ${installerExe}`)}
wine ${shellQuote(installerExe)}
`;
      break;
    }

    case DistributionType.ArchiveBundle: {
      setupCommand = "drop-pipeline-setup.bat";
      const archive = classification.primaryArchive || "*.7z";

      steps.push(
        {
          id: "extract_archive",
          action: "extract_archive",
          params: {
            archiveFile: archive,
            outputDir: ".",
          },
          description: `Extract compressed archive (${archive})`,
        },
        {
          id: "cleanup",
          action: "cleanup",
          params: {
            targets: [archive],
          },
          description: "Remove source archive",
          optional: true,
        },
      );

      setupScriptWindows = String.raw`@echo off
echo ${batchEcho(`[Drop Pipeline] Extracting Archive (${archive})...`)}
set SEVENZIP="7z"
if exist "%ProgramFiles%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles%\7-Zip\7z.exe"
if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\7-Zip\7z.exe"

%SEVENZIP% x -y ${batchQuote(archive)} -o.
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo ${shellQuote(`[Drop Pipeline] Extracting Archive (${archive})...`)}
7z x -y ${shellQuote(archive)} -o.
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
