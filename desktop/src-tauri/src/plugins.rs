use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use database::borrow_db_checked;
use process::path_guard;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedExecutable {
    pub relative_path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntiCheatReport {
    pub detected: bool,
    pub provider: Option<String>,
    pub files: Vec<String>,
}

fn get_game_install_dir(game_id: &str) -> Result<PathBuf, String> {
    let db = borrow_db_checked();
    if let Some(database::GameDownloadStatus::Installed { install_dir, .. }) =
        db.applications.game_statuses.get(game_id)
    {
        let path = PathBuf::from(install_dir);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Game install directory does not exist: {}",
            path.display()
        ));
    }
    Err(format!(
        "Game with id '{game_id}' is not installed or not found in local database"
    ))
}

fn compute_file_sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn plugin_game_fs_read(
    game_id: String,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let safe_path = path_guard::safe_join(&install_dir, &relative_path)
        .map_err(|e| format!("Security check failed: {e}"))?;

    fs::read(&safe_path).map_err(|e| format!("Failed to read {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_fs_write(
    game_id: String,
    relative_path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    path_guard::write_file(&install_dir, &relative_path, &data)
        .map_err(|e| format!("Failed to write {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_fs_backup(
    game_id: String,
    relative_path: String,
) -> Result<String, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let src_path = path_guard::safe_join(&install_dir, &relative_path)
        .map_err(|e| format!("Security check failed: {e}"))?;

    if !src_path.exists() {
        return Err(format!(
            "Cannot backup nonexistent file: {}",
            src_path.display()
        ));
    }

    let backup_relative = format!("{}.drop-backup", relative_path);
    path_guard::copy_to(&install_dir, &src_path, &backup_relative)
        .map_err(|e| format!("Failed to create backup {backup_relative}: {e}"))?;

    Ok(backup_relative)
}

#[tauri::command]
pub async fn plugin_game_fs_restore(
    game_id: String,
    relative_path: String,
) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let backup_relative = format!("{}.drop-backup", relative_path);
    let backup_path = path_guard::safe_join(&install_dir, &backup_relative)
        .map_err(|e| format!("Security check failed: {e}"))?;

    if !backup_path.exists() {
        return Err(format!(
            "Cannot restore missing backup file: {backup_relative}"
        ));
    }

    path_guard::copy_to(&install_dir, &backup_path, &relative_path)
        .map_err(|e| format!("Failed to restore file from backup: {e}"))?;

    // Cleanup backup file
    let _ = path_guard::remove_file(&install_dir, &backup_relative);

    Ok(())
}

#[tauri::command]
pub async fn plugin_game_fs_exists(
    game_id: String,
    relative_path: String,
) -> Result<bool, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    match path_guard::safe_join(&install_dir, &relative_path) {
        Ok(safe_path) => Ok(safe_path.exists()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn plugin_game_fs_delete(
    game_id: String,
    relative_path: String,
) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    path_guard::remove_file(&install_dir, &relative_path)
        .map_err(|e| format!("Failed to delete {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_scan_executables(
    game_id: String,
) -> Result<Vec<ScannedExecutable>, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let mut executables = Vec::new();

    for entry in WalkDir::new(&install_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        // Never follow or scan symlinks for executable security
        if path_guard::is_symlink(path) {
            continue;
        }

        let is_exec = if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            let lower = ext.to_lowercase();
            matches!(
                lower.as_str(),
                "exe" | "dll" | "so" | "bin" | "x86_64" | "elf" | "dylib"
            )
        } else {
            false
        };

        #[cfg(unix)]
        let is_exec = is_exec || {
            use std::os::unix::fs::PermissionsExt;
            entry
                .metadata()
                .map(|m| (m.permissions().mode() & 0o111) != 0)
                .unwrap_or(false)
        };

        if is_exec {
            if let Ok(rel_path) = path.strip_prefix(&install_dir) {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let sha256 = compute_file_sha256(path)
                    .unwrap_or_else(|_| String::from("unknown-sha256"));

                executables.push(ScannedExecutable {
                    relative_path: rel_path.to_string_lossy().to_string(),
                    sha256,
                    size,
                });
            }
        }
    }

    Ok(executables)
}

#[tauri::command]
pub async fn plugin_game_check_anticheat(game_id: String) -> Result<AntiCheatReport, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let mut detected_files = Vec::new();
    let mut detected_provider: Option<String> = None;

    for entry in WalkDir::new(&install_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let path_str = path.to_string_lossy().to_lowercase();

        let provider = if path_str.contains("easyanticheat")
            || path_str.contains("eac_server")
            || path_str.contains("easyanticheat_x64.dll")
        {
            Some("easyanticheat")
        } else if path_str.contains("battleye")
            || path_str.contains("beservice")
            || path_str.contains("beclient")
        {
            Some("battleye")
        } else if path_str.contains("vgk.sys") || path_str.contains("vgc.exe") {
            Some("vanguard")
        } else if path_str.contains("denuvo") || path_str.contains("dbdata.dll") {
            Some("denuvo")
        } else {
            None
        };

        if let Some(p) = provider {
            if let Ok(rel) = path.strip_prefix(&install_dir) {
                detected_files.push(rel.to_string_lossy().to_string());
                if detected_provider.is_none() {
                    detected_provider = Some(p.to_string());
                }
            }
        }
    }

    let detected = !detected_files.is_empty();
    Ok(AntiCheatReport {
        detected,
        provider: detected_provider,
        files: detected_files,
    })
}
