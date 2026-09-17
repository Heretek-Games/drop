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

function toWindowsPath(value: string): string {
  return value.split("/").join("\\");
}

/**
 * Builds steps and setup scripts for a patch/update release. Updates either
 * ship a patcher executable (run over the base install) or an overlay
 * directory (copied over the base install); everything may additionally be
 * wrapped in a single- or multi-part archive.
 */
function buildPatchUpdateRecipe(
  classification: ClassificationResult,
  steps: PipelineStep[],
): {
  setupCommand: string | undefined;
  setupScriptWindows: string | undefined;
  setupScriptLinux: string | undefined;
} {
  const setupCommand = "drop-pipeline-setup.bat";
  const tmp = ".drop_patch_tmp";
  const patcher = classification.installerExe?.replaceAll("\\", "/");
  const archive = classification.primaryArchive;
  const isRar = archive?.toLowerCase().endsWith(".rar") ?? false;
  const group = classification.releaseGroup ?? "Update";

  if (archive) {
    steps.push(
      isRar
        ? {
            id: "extract_patch_rar",
            action: "extract_rar",
            params: {
              input: archive,
              outputDir: tmp,
            },
            description: `Extract multi-part update archive (${archive})`,
          }
        : {
            id: "extract_patch_archive",
            action: "extract_archive",
            params: {
              archiveFile: archive,
              outputDir: tmp,
            },
            description: `Extract update archive (${archive})`,
          },
    );
  }

  // Patch contents live at the version root when unpacked, or inside the
  // temp directory after extraction.
  const prefix = archive ? tmp + "/" : "";
  const patcherTarget = patcher ? prefix + patcher : undefined;
  const overlayTarget = classification.updateDir
    ? prefix + classification.updateDir
    : undefined;

  if (patcherTarget) {
    steps.push({
      id: "run_update_patcher",
      action: "run_command",
      params: {
        command: patcherTarget,
        targetDir: ".",
      },
      description: `Run update patcher (${patcherTarget})`,
    });
  } else if (overlayTarget) {
    steps.push({
      id: "apply_update_overlay",
      action: "apply_crack",
      params: {
        crackDir: overlayTarget,
        targetDir: ".",
      },
      description: `Apply update overlay (${overlayTarget})`,
    });
  } else if (archive) {
    // Patch files directly inside the archive with no patcher and no
    // dedicated overlay directory: copy everything over the base install.
    steps.push({
      id: "apply_update_overlay",
      action: "apply_crack",
      params: {
        crackDir: tmp,
        targetDir: ".",
      },
      description: "Copy patch files over the base game install",
    });
  }

  if (archive) {
    steps.push({
      id: "cleanup",
      action: "cleanup",
      params: {
        targets: isRar
          ? [tmp, "*.r0*", "*.r1*", "*.r2*", "*.rar"]
          : [tmp, archive],
      },
      description: "Remove update archive and temporary extraction",
      optional: true,
    });
  }

  return {
    setupCommand,
    ...buildPatchUpdateScripts({
      group,
      archive,
      patcherTarget,
      overlayTarget,
      tmp,
    }),
  };
}

interface PatchUpdateScriptContext {
  group: string;
  archive?: string;
  patcherTarget?: string;
  overlayTarget?: string;
  tmp: string;
}

/** Generates standalone `.bat`/`.sh` fallbacks for a patch/update release. */
function buildPatchUpdateScripts(ctx: PatchUpdateScriptContext): {
  setupScriptWindows: string;
  setupScriptLinux: string;
} {
  const { group, archive, patcherTarget, overlayTarget, tmp } = ctx;

  const label = "[Drop Pipeline] Applying Game Update (" + group + ")...";

  const windowsPieces: string[] = ["@echo off", "echo " + batchEcho(label)];
  if (archive) {
    windowsPieces.push(
      String.raw`set SEVENZIP="7z"
if exist "%ProgramFiles%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles%\7-Zip\7z.exe"
if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\7-Zip\7z.exe"

%SEVENZIP% x -y ` +
        batchQuote(archive!) +
        ` -o` +
        tmp +
        `
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Update archive extraction failed.
  exit /b %ERRORLEVEL%
)`,
    );
  }
  if (patcherTarget) {
    windowsPieces.push(
      "echo [Drop Pipeline] Running update patcher...",
      'start /wait "" ' + batchQuote(toWindowsPath(patcherTarget!)),
      `if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Update patcher failed.
  exit /b %ERRORLEVEL%
)`,
    );
  } else if (overlayTarget || archive) {
    const source = toWindowsPath(overlayTarget ?? tmp);
    windowsPieces.push(
      "echo [Drop Pipeline] Applying update overlay...",
      "xcopy /s /e /y " +
        batchQuote(source + String.raw`\*`) +
        " " +
        batchQuote("."),
    );
  }
  if (archive) {
    windowsPieces.push(
      "if exist " + batchQuote(tmp) + " rmdir /s /q " + batchQuote(tmp),
    );
  }
  windowsPieces.push("echo [Drop Pipeline] Game update applied successfully!");
  windowsPieces.push("exit /b 0");

  const linuxPieces: string[] = ["#!/bin/bash", "echo " + shellQuote(label)];
  if (archive) {
    linuxPieces.push("7z x -y " + shellQuote(archive!) + " -o" + tmp);
  }
  if (patcherTarget) {
    linuxPieces.push(
      'echo "[Drop Pipeline] Running update patcher..."',
      "wine " + shellQuote(patcherTarget!),
    );
  } else if (overlayTarget || archive) {
    const source = overlayTarget ?? tmp;
    linuxPieces.push(
      `echo "[Drop Pipeline] Applying update overlay..."`,
      "cp -rf " + shellQuote(source) + "/. .",
    );
  }
  if (archive) {
    linuxPieces.push("rm -rf " + shellQuote(tmp));
  }
  linuxPieces.push(`echo "[Drop Pipeline] Game update applied successfully!"`);

  return {
    setupScriptWindows: windowsPieces.join("\n"),
    setupScriptLinux: linuxPieces.join("\n"),
  };
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

    case DistributionType.PatchUpdate: {
      ({ setupCommand, setupScriptWindows, setupScriptLinux } =
        buildPatchUpdateRecipe(classification, steps));
      break;
    }

    case DistributionType.GogInstaller: {
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

      // Repack wrappers are Inno Setup shells, so silent flags skip the wizard
      // prompts (component/language screens) while keeping the progress UI.
      steps.push({
        id: "run_installer",
        action: "run_command",
        params: {
          command: `${installerExe} /SILENT /SUPPRESSMSGBOXES /NORESTART`,
          targetDir: ".",
        },
        description: `Run repack installer (${installerExe}) silently`,
      });

      setupScriptWindows = `@echo off
echo ${batchEcho(`[Drop Pipeline] Launching Repack Installer (${installerExe})...`)}
start /wait "" ${batchQuote(installerExe)} /SILENT /SUPPRESSMSGBOXES /NORESTART
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Silent installation failed; relaunching interactively...
  start /wait "" ${batchQuote(installerExe)}
)
exit /b %ERRORLEVEL%
`;

      setupScriptLinux = `#!/bin/bash
echo ${shellQuote(`[Drop Pipeline] Repack installation under Wine/Proton required for ${installerExe}`)}
${shellQuote(installerExe)} /SILENT /SUPPRESSMSGBOXES /NORESTART
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
    versionHint: classification.versionHint,
    steps,
    targetExecutable,
    setupCommand,
    setupScriptWindows,
    setupScriptLinux,
    recommendedPlatform: "windows",
  };
}
