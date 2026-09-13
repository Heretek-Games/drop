#!/usr/bin/env python3
"""
Tool: fix_placeholder_configs.py

Audits and repairs game versions and configurations in the Drop database:
1. Classifies each game version's distribution archetype (Scene RARs, GOG,
   FitGirl, KaOs, Archive Bundle, Loose Portable).
2. Uses on-disk directory inspection when available; falls back to the database
   'fileList' if on-disk paths are unavailable.
3. Generates complete declarative pipeline recipes (steps, scripts, targets)
   and attaches them directly to GameVersion.dropletManifest.
4. Corrects placeholder launch/setup commands ('drop-start.bat', 'exr-setup.bat',
   'change-start.bat') to real launch binaries and 'drop-pipeline-setup.bat'.
5. Strictly enforces ZERO IN-PLACE MUTATION on monitored seeding storage.

Usage:
  python3 fix_placeholder_configs.py [--apply] [--all-manifests]
"""

import os
import sys
import re
import json
import argparse
from urllib.parse import urlparse
import pg8000.native

DEFAULT_DB_URL = os.environ.get("DATABASE_URL", "postgresql://drop:drop@127.0.0.1:5432/drop")

SCENE_GROUPS = [
    "RUNE", "TENOKE", "CODEX", "SKIDROW", "PLAZA", "FLT", "DEViANCE",
    "RELOADED", "HOODLUM", "FAIRLIGHT", "DOGE", "EMPRESS", "PARADiGM",
    "PROPHET", "TiNYiSO", "ALiAS", "BAT", "Razor1911", "FLTDOX", "RazorDOX",
    "SiMPLEX", "DARKSiDERS", "DINOByTES", "Chrono", "Unleashed", "HI2U"
]
SCENE_GROUP_REGEX = re.compile(rf"[-_. ]({'|'.join(SCENE_GROUPS)})([-_.]|$)", re.I)

EXCLUDED_PATTERNS = [
    re.compile(r"unins\d*\.exe$", re.I),
    re.compile(r"uninstall.*\.exe$", re.I),
    re.compile(r"setup.*\.exe$", re.I),
    re.compile(r"install.*\.exe$", re.I),
    re.compile(r"unitycrashhandler(32|64)?\.exe$", re.I),
    re.compile(r"crashreportclient.*\.exe$", re.I),
    re.compile(r"unrealcefsubprocess\.exe$", re.I),
    re.compile(r"vc_?redist.*\.exe$", re.I),
    re.compile(r"dxwebsetup\.exe$", re.I),
    re.compile(r"dotnet.*\.exe$", re.I),
    re.compile(r"quicksfv\.exe$", re.I),
    re.compile(r"autorun\.exe$", re.I),
    re.compile(r"verify.*\.exe$", re.I),
    re.compile(r"language.*\.exe$", re.I),
    re.compile(r"^7z.*\.exe$", re.I),
]

EXCLUDED_DIR_PATTERNS = [
    re.compile(r"[/\\](_commonredist|redist|directx|support|dependencies|crack|rune|tenoke|codex|goldberg)[/\\]", re.I)
]

SETUP_SCRIPT = "drop-pipeline-setup.bat"
DEFAULT_SETUP_EXE = "setup.exe"
FALLBACK_ARCHIVE = "*.rar"
PLACEHOLDER_LAUNCH_COMMANDS = ("drop-start.bat", "exr-setup.bat", "change-start.bat")
PLACEHOLDER_SETUP_COMMANDS = ("exr-setup.bat", "drop-start.bat")

def score_executable(norm, base, clean_game, game_tokens):
    score = 10
    base_lower = base.lower()
    if "-win64-shipping.exe" in base_lower:
        score += 45
    if "/binaries/win64/" in norm.lower() or "/bin/x64/" in norm.lower() or "/x64/" in norm.lower():
        score += 30
    elif "/binaries/" in norm.lower() or "/bin/" in norm.lower():
        score += 15
    elif "/" not in norm:
        score += 20

    base_clean = re.sub(r"[^a-zA-Z0-9]", "", os.path.splitext(base_lower)[0]).lower()
    if base_clean == clean_game:
        score += 50
    elif clean_game in base_clean or base_clean in clean_game:
        score += 35
    else:
        file_tokens = set(re.split(r"[\s_\-.:]+", os.path.splitext(base)[0].lower()))
        overlap = len(game_tokens & file_tokens)
        if overlap:
            score += overlap * 10

    return score

def score_executables(files, game_name):
    clean_game = re.sub(r"[^a-zA-Z0-9]", "", game_name).lower()
    game_tokens = set(re.split(r"[\s_\-.:]+", game_name.lower())) - {"", "the", "a", "an", "edition", "version"}

    candidates = []
    for f in files:
        norm = f.replace("\\", "/")
        base = os.path.basename(norm)
        if not base.lower().endswith(".exe"):
            continue
        if any(p.search(base) for p in EXCLUDED_PATTERNS):
            continue
        if any(p.search(norm) for p in EXCLUDED_DIR_PATTERNS):
            continue

        candidates.append((score_executable(norm, base, clean_game, game_tokens), norm))

    candidates.sort(reverse=True)
    return [c[1] for c in candidates]

def _fallback_target(files, game_name):
    exes = score_executables(files, game_name)
    return exes[0] if exes else f"{game_name}.exe"

def _classify_scene_release(files, game_name, rars, has_iso, release_group):
    if len(rars) == 0 and not (has_iso and release_group):
        return None
    primary_rar = next((f for f in files if re.search(r"\.part0*1\.rar$", f.lower())), None)
    if not primary_rar:
        primary_rar = next((f for f in files if f.lower().endswith(".rar")), rars[0] if rars else FALLBACK_ARCHIVE)

    return {
        "type": "SceneRelease",
        "group": release_group or "Scene",
        "target": _fallback_target(files, game_name),
        "setup": SETUP_SCRIPT,
        "primary": primary_rar
    }

def _classify_fitgirl(files, folder_name, game_name):
    lower_folder = folder_name.lower()
    if not ("[fitgirl repack]" in lower_folder or any(f.lower().startswith("fg-") for f in files) or any("fitgirl" in f.lower() for f in files)):
        return None
    return {
        "type": "FitGirlRepack",
        "group": "FitGirl",
        "target": _fallback_target(files, game_name),
        "setup": SETUP_SCRIPT
    }

def _classify_kaos(files, folder_name, game_name):
    lower_folder = folder_name.lower()
    if not ("repack-kaos" in lower_folder or "[kaos repack]" in lower_folder or any(f.lower().startswith("kaos-") for f in files) or any("repack-kaos" in f.lower() for f in files)):
        return None
    return {
        "type": "KaOsRepack",
        "group": "KaOs",
        "target": _fallback_target(files, game_name),
        "setup": SETUP_SCRIPT
    }

def _classify_gog(files, folder_name, game_name):
    gog_setup = next((f for f in files if os.path.basename(f).lower().startswith("setup_") and f.lower().endswith(".exe")), None)
    if not (gog_setup or "gog" in folder_name.lower() or any(f.lower().endswith(".bin") and "setup_" in f.lower() for f in files)):
        return None
    exes = score_executables(files, game_name)
    target = f"app/{exes[0]}" if exes else f"app/{game_name}.exe"
    return {
        "type": "GogInstaller",
        "group": "GOG",
        "target": target,
        "setup": SETUP_SCRIPT,
        "installer": gog_setup or DEFAULT_SETUP_EXE
    }

def _classify_archive_bundle(files, game_name):
    archives = [f for f in files if os.path.splitext(f)[1].lower() in [".7z", ".zip", ".rar"]]
    if not archives:
        return None
    return {
        "type": "ArchiveBundle",
        "target": _fallback_target(files, game_name),
        "setup": SETUP_SCRIPT,
        "archive": archives[0]
    }

def _classify_loose_portable(files, game_name):
    exes = score_executables(files, game_name)
    if not exes:
        return None
    return {
        "type": "LoosePortable",
        "target": exes[0],
        "setup": None
    }

def classify_files_and_folder(all_files, folder_name, game_name):
    group_match = SCENE_GROUP_REGEX.search(folder_name)
    release_group = group_match.group(1).upper() if group_match else None

    rars = [f for f in all_files if f.lower().endswith(".rar") or re.search(r"\.r\d{2}$", f.lower()) or re.search(r"\.part\d+\.rar$", f.lower())]
    has_iso = any(f.lower().endswith(".iso") for f in all_files)

    classifiers = (
        lambda: _classify_scene_release(all_files, game_name, rars, has_iso, release_group),
        lambda: _classify_fitgirl(all_files, folder_name, game_name),
        lambda: _classify_kaos(all_files, folder_name, game_name),
        lambda: _classify_gog(all_files, folder_name, game_name),
        lambda: _classify_archive_bundle(all_files, game_name),
        lambda: _classify_loose_portable(all_files, game_name),
    )
    for classify in classifiers:
        result = classify()
        if result:
            return result

    return {"type": "Unknown", "target": f"{game_name}.exe", "setup": None}

def build_recipe(info, game_name):
    dist_type = info["type"]
    target = info.get("target", f"{game_name}.exe")
    setup_cmd = info.get("setup")
    steps = []

    if dist_type == "SceneRelease":
        primary = info.get("primary", FALLBACK_ARCHIVE)
        group = info.get("group", "Scene")
        steps = [
            {"id": "extract_rar", "action": "extract_rar", "params": {"input": primary, "outputDir": ".drop_iso_tmp"}, "description": f"Extract multi-part Scene archive ({primary})"},
            {"id": "extract_iso", "action": "extract_iso", "params": {"sourceGlob": ".drop_iso_tmp/*.iso", "outputDir": "."}, "description": "Extract unpacked ISO disc image into root game folder"},
            {"id": "apply_crack", "action": "apply_crack", "params": {"crackDir": group, "targetDir": "."}, "description": f"Apply {group} crack overlay", "optional": True},
            {"id": "cleanup", "action": "cleanup", "params": {"targets": [".drop_iso_tmp", "*.r0*", "*.r1*", "*.r2*", "*.r3*", FALLBACK_ARCHIVE]}, "description": "Remove intermediate ISO and multi-part RAR slices", "optional": True}
        ]
        bat = f"""@echo off
echo [Drop Pipeline] Extracting Scene Release ({group})...
set SEVENZIP="7z"
if exist "%ProgramFiles%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles%\\7-Zip\\7z.exe"
if exist "%ProgramFiles(x86)%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\\7-Zip\\7z.exe"

echo [Drop Pipeline] Extracting archives to temporary directory...
%SEVENZIP% x -y "{primary}" -o.drop_iso_tmp
if %ERRORLEVEL% NEQ 0 (
  echo [Drop Pipeline] Archive extraction failed.
  exit /b %ERRORLEVEL%
)

for %%F in (.drop_iso_tmp\\*.iso) do (
  echo [Drop Pipeline] Extracting ISO %%F...
  %SEVENZIP% x -y "%%F" -o.
)

for %%G in (RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack) do (
  if exist "%%G" (
    echo [Drop Pipeline] Applying crack from %%G...
    xcopy /s /e /y "%%G\\*" "."
  )
  if exist ".drop_iso_tmp\\%%G" (
    echo [Drop Pipeline] Applying crack from .drop_iso_tmp\\%%G...
    xcopy /s /e /y ".drop_iso_tmp\\%%G\\*" "."
  )
)

if exist .drop_iso_tmp rmdir /s /q .drop_iso_tmp
echo [Drop Pipeline] Scene release setup completed successfully!
exit /b 0
"""
        sh = f"""#!/bin/bash
set -e
echo "[Drop Pipeline] Extracting Scene Release ({group})..."
mkdir -p .drop_iso_tmp
7z x -y "{primary}" -o.drop_iso_tmp
for iso in .drop_iso_tmp/*.iso; do
  if [ -f "$iso" ]; then
    echo "[Drop Pipeline] Extracting $iso..."
    7z x -y "$iso" -o.
  fi
done

for g in RUNE TENOKE CODEX FLT PLAZA SKIDROW DEViANCE RELOADED HOODLUM FAIRLIGHT EMPRESS PROPHET TiNYiSO ALiAS BAT Razor1911 Crack; do
  if [ -d "$g" ]; then
    echo "[Drop Pipeline] Applying crack from $g..."
    cp -rf "$g"/* .
  fi
  if [ -d ".drop_iso_tmp/$g" ]; then
    echo "[Drop Pipeline] Applying crack from .drop_iso_tmp/$g..."
    cp -rf ".drop_iso_tmp/$g"/* .
  fi
done

rm -rf .drop_iso_tmp
echo "[Drop Pipeline] Scene release setup completed successfully!"
"""
        return {
            "distributionType": dist_type,
            "steps": steps,
            "targetExecutable": target,
            "setupCommand": setup_cmd,
            "setupScriptWindows": bat,
            "setupScriptLinux": sh
        }

    elif dist_type == "GogInstaller":
        installer = info.get("installer", DEFAULT_SETUP_EXE)
        steps = [
            {"id": "innoextract", "action": "innoextract", "params": {"installerExe": installer, "outputDir": "app"}, "description": f"Extract GOG Inno Setup installer ({installer})"},
            {"id": "cleanup", "action": "cleanup", "params": {"targets": ["*.bin", installer]}, "description": "Remove GOG setup and data .bin files", "optional": True}
        ]
        bat = f"""@echo off
echo [Drop Pipeline] Installing GOG release ({installer})...
where innoextract >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [Drop Pipeline] Extracting with innoextract...
  innoextract -e -d app "{installer}"
  exit /b 0
)

echo [Drop Pipeline] Launching GOG silent installer...
start /wait "" "{installer}" /VERYSILENT /SUPPRESSMSGBOXES /DIR="%CD%\\app"
if %ERRORLEVEL% EQU 0 exit /b 0

echo [Drop Pipeline] Falling back to interactive setup...
start /wait "" "{installer}"
exit /b %ERRORLEVEL%
"""
        sh = f"""#!/bin/bash
echo "[Drop Pipeline] Installing GOG release ({installer})..."
if command -v innoextract >/dev/null 2>&1; then
  echo "[Drop Pipeline] Extracting with innoextract..."
  innoextract -e -d app "{installer}"
  exit 0
else
  echo "[Drop Pipeline] Error: innoextract is required on Linux to extract GOG installers."
  exit 1
fi
"""
        return {
            "distributionType": dist_type,
            "steps": steps,
            "targetExecutable": target,
            "setupCommand": setup_cmd,
            "setupScriptWindows": bat,
            "setupScriptLinux": sh
        }

    elif dist_type in ("FitGirlRepack", "KaOsRepack"):
        group = info.get("group", "Repack")
        installer = DEFAULT_SETUP_EXE if dist_type == "FitGirlRepack" else "Install.exe"
        steps = [
            {"id": "run_installer", "action": "run_command", "params": {"command": installer, "targetDir": "."}, "description": f"Run {group} installer ({installer})"}
        ]
        bat = f"""@echo off
echo [Drop Pipeline] Launching {group} Installer ({installer})...
start /wait "" "{installer}"
exit /b %ERRORLEVEL%
"""
        sh = f"""#!/bin/bash
echo "[Drop Pipeline] Repack installation under Wine/Proton required for {installer}"
wine "{installer}"
"""
        return {
            "distributionType": dist_type,
            "steps": steps,
            "targetExecutable": target,
            "setupCommand": setup_cmd,
            "setupScriptWindows": bat,
            "setupScriptLinux": sh
        }

    elif dist_type == "ArchiveBundle":
        archive = info.get("archive", "*.7z")
        steps = [
            {"id": "extract_archive", "action": "extract_archive", "params": {"archiveFile": archive, "outputDir": "."}, "description": f"Extract compressed archive ({archive})"},
            {"id": "cleanup", "action": "cleanup", "params": {"targets": [archive]}, "description": "Remove source archive", "optional": True}
        ]
        bat = f"""@echo off
echo [Drop Pipeline] Extracting {archive}...
set SEVENZIP="7z"
if exist "%ProgramFiles%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles%\\7-Zip\\7z.exe"
if exist "%ProgramFiles(x86)%\\7-Zip\\7z.exe" set SEVENZIP="%ProgramFiles(x86)%\\7-Zip\\7z.exe"

%SEVENZIP% x -y "{archive}" -o.
exit /b %ERRORLEVEL%
"""
        sh = f"""#!/bin/bash
set -e
echo "[Drop Pipeline] Extracting {archive}..."
7z x -y "{archive}" -o.
"""
        return {
            "distributionType": dist_type,
            "steps": steps,
            "targetExecutable": target,
            "setupCommand": setup_cmd,
            "setupScriptWindows": bat,
            "setupScriptLinux": sh
        }

    else:
        # LoosePortable or Unknown
        return {
            "distributionType": dist_type,
            "steps": [],
            "targetExecutable": target,
            "setupCommand": None
        }

def parse_args():
    parser = argparse.ArgumentParser(description="Repair Drop database placeholder configurations and populate pipeline recipes.")
    parser.add_argument("--apply", action="store_true", help="Apply changes directly to the PostgreSQL database.")
    parser.add_argument("--all-manifests", action="store_true", help="Also attach pipeline recipes to all GameVersion dropletManifests.")
    parser.add_argument("--db-url", default=DEFAULT_DB_URL, help="PostgreSQL connection string (defaults to DATABASE_URL or postgresql://drop:drop@127.0.0.1:5432/drop)")
    return parser.parse_args()


def connect_db(db_url):
    parsed_url = urlparse(db_url)
    return pg8000.native.Connection(
        user=parsed_url.username or "drop",
        password=parsed_url.password or "drop",
        host=parsed_url.hostname or "127.0.0.1",
        port=parsed_url.port or 5432,
        database=parsed_url.path.lstrip("/") or "drop"
    )


ROW_QUERY = """
    SELECT DISTINCT
      g.id as game_id,
      g."mName" as game_name,
      g."libraryPath" as game_path,
      gv."versionId" as version_id,
      gv."versionPath" as version_path,
      l.options->>'baseDir' as base_dir,
      lc."launchId" as launch_id,
      lc.command as launch_command,
      sc."setupId" as setup_id,
      sc.command as setup_command,
      gv."fileList" as file_list,
      gv."dropletManifest"::text as manifest_text
    FROM "GameVersion" gv
    JOIN "Game" g ON gv."gameId" = g.id
    JOIN "Library" l ON g."libraryId" = l.id
    LEFT JOIN "LaunchConfiguration" lc ON lc."versionId" = gv."versionId"
    LEFT JOIN "SetupConfiguration" sc ON sc."versionId" = gv."versionId"
"""


def select_rows(conn, all_manifests):
    query = ROW_QUERY
    if not all_manifests:
        query += """
            WHERE lc.command IN ('drop-start.bat', 'exr-setup.bat', 'change-start.bat')
               OR sc.command IN ('exr-setup.bat', 'drop-start.bat')
               OR gv."dropletManifest"::text NOT LIKE '%"recipe"%'
        """
    query += ' ORDER BY g."mName"'
    return conn.run(query)


def fix_library_pointer(conn):
    conn.run("""
        UPDATE "Game"
        SET "libraryId" = 'c03c9c8b-63c1-4070-970a-81746d63d174'
        WHERE "mName" = 'Caves of Qud' AND "libraryId" != 'c03c9c8b-63c1-4070-970a-81746d63d174'
    """)


def resolve_target_path(base_dir, game_path, version_path):
    if not (base_dir and game_path):
        return None
    target_path = os.path.join(base_dir, game_path)
    if version_path:
        candidate = os.path.join(target_path, version_path)
        if os.path.exists(candidate):
            target_path = candidate
    return target_path


def walk_candidate_files(root):
    """Lists files under root, pruning subtrees deeper than two levels."""
    found = []
    for walk_root, dirs, files in os.walk(root):
        rel = os.path.relpath(walk_root, root)
        for f in files:
            found.append(os.path.join(rel, f) if rel != "." else f)
        if rel.count(os.sep) >= 2:
            dirs.clear()
    return found


def collect_candidate_files(target_path, file_list):
    candidate_files = []
    if target_path and os.path.exists(target_path):
        try:
            candidate_files = walk_candidate_files(target_path)
        except Exception:
            pass

    if not candidate_files and file_list:
        candidate_files = list(file_list)
    return candidate_files


def parse_manifest(manifest_text):
    manifest_obj = {}
    if manifest_text:
        try:
            manifest_obj = json.loads(manifest_text)
            if isinstance(manifest_obj, str):
                manifest_obj = json.loads(manifest_obj)
        except Exception:
            manifest_obj = {}
    return manifest_obj if isinstance(manifest_obj, dict) else {}


def get_recipe_field(manifest_obj):
    recipe_field = manifest_obj.get("recipe")
    if isinstance(recipe_field, str):
        try:
            recipe_field = json.loads(recipe_field)
        except Exception:
            recipe_field = {}
    return recipe_field if isinstance(recipe_field, dict) else {}


def repair_launch_and_setup(conn, launch_id, setup_id, version_id, game_name, info):
    if launch_id:
        conn.run("""
            UPDATE "LaunchConfiguration"
            SET command = :cmd, name = :name
            WHERE "launchId" = :lid
        """, cmd=info["target"], name=game_name, lid=launch_id)

    if setup_id:
        if info.get("setup"):
            conn.run("""
                UPDATE "SetupConfiguration"
                SET command = :cmd
                WHERE "setupId" = :sid
            """, cmd=info["setup"], sid=setup_id)
        else:
            conn.run("""
                DELETE FROM "SetupConfiguration"
                WHERE "setupId" = :sid
            """, sid=setup_id)
    elif info.get("setup"):
        conn.run("""
            INSERT INTO "SetupConfiguration" ("setupId", "versionId", command, platform)
            VALUES (gen_random_uuid()::text, :vid, :cmd, 'Windows')
        """, vid=version_id, cmd=info["setup"])


def apply_manifest_recipe(conn, version_id, manifest_obj, recipe):
    manifest_obj["recipe"] = recipe
    conn.run("""
        UPDATE "GameVersion"
        SET "dropletManifest" = :m::jsonb
        WHERE "versionId" = :vid
    """, m=json.dumps(manifest_obj), vid=version_id)


def print_summary(rows, stats, repaired_configs, updated_manifests, applied):
    print("\n=== Summary ===")
    print(f"Total Rows Inspected: {len(rows)}")
    print("Archetype Breakdown:")
    for k, v in sorted(stats.items()):
        print(f"  {k:16}: {v}")

    if applied:
        print(f"\nSuccessfully repaired {repaired_configs} placeholder configurations!")
        print(f"Successfully attached pipeline recipes to {updated_manifests} GameVersions!")
    else:
        print("\nDry run complete. Use --apply to commit these changes to PostgreSQL.")


def process_row(conn, row, apply_changes, stats):
    """Classifies one row and optionally repairs its config/manifest.

    Returns (repaired_configs, updated_manifests) for this row.
    """
    (
        _,
        game_name,
        game_path,
        version_id,
        version_path,
        base_dir,
        launch_id,
        launch_cmd,
        setup_id,
        setup_cmd,
        file_list,
        manifest_text,
    ) = row

    target_path = resolve_target_path(base_dir, game_path, version_path)
    folder_name = (
        os.path.basename(target_path)
        if target_path
        else (version_path or game_path or game_name)
    )
    candidate_files = collect_candidate_files(target_path, file_list)

    info = classify_files_and_folder(candidate_files, folder_name, game_name)
    recipe = build_recipe(info, game_name)
    stats[info["type"]] = stats.get(info["type"], 0) + 1

    is_placeholder = (
        launch_cmd in PLACEHOLDER_LAUNCH_COMMANDS
        or setup_cmd in PLACEHOLDER_SETUP_COMMANDS
    )

    manifest_obj = parse_manifest(manifest_text)
    recipe_field = get_recipe_field(manifest_obj)
    needs_manifest_update = (
        "recipe" not in manifest_obj
        or recipe_field.get("distributionType") != info["type"]
    )

    if is_placeholder or needs_manifest_update:
        print(
            f"[{info['type']:14}] {game_name:36} -> Launch: {info['target']} | Setup: {info.get('setup')}"
        )

    if not apply_changes:
        return (0, 0)

    repaired = 0
    updated = 0
    if is_placeholder:
        repair_launch_and_setup(conn, launch_id, setup_id, version_id, game_name, info)
        repaired = 1

    if needs_manifest_update:
        apply_manifest_recipe(conn, version_id, manifest_obj, recipe)
        updated = 1

    return (repaired, updated)


def main():
    args = parse_args()

    print("=== Drop Distribution Pipeline - Configuration & Manifest Engine ===")
    print(f"Mode: {'APPLY CHANGES' if args.apply else 'DRY RUN (preview only, use --apply to commit)'}\n")

    conn = connect_db(args.db_url)

    # 1. Fix library pointer for Caves of Qud if needed
    if args.apply:
        fix_library_pointer(conn)

    # 2. Select rows to inspect
    rows = select_rows(conn, args.all_manifests)
    print(f"Found {len(rows)} configuration rows to inspect.\n")

    stats = {}
    repaired_configs = 0
    updated_manifests = 0

    for r in rows:
        repaired, updated = process_row(conn, r, args.apply, stats)
        repaired_configs += repaired
        updated_manifests += updated

    print_summary(rows, stats, repaired_configs, updated_manifests, args.apply)

if __name__ == "__main__":
    main()
