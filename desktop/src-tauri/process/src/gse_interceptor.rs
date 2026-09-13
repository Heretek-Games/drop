use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::ProcessError, interceptor::LaunchInterceptor};

/// Anti-cheat executable and library markers.
pub const ANTICHEAT_MARKERS: &[&str] = &[
    "easyanticheat.exe",
    "easyanticheat_x64.dll",
    "easyanticheat_x86.dll",
    "easyanticheat.so",
    "beservice.exe",
    "bedaisy.sys",
    "battleye.dll",
];

/// Target steam_api binaries supported across platforms.
pub const TARGET_BINARIES: &[&str] = &[
    "steam_api.dll",
    "steam_api64.dll",
    "libsteam_api.so",
];

pub const MANIFEST_FILENAME: &str = ".drop-gse-manifest.json";

#[derive(Debug, Serialize, Deserialize, Default)]
struct GseManifest {
    entries: BTreeMap<String, String>,
}

fn sha256_of(path: &Path) -> Result<String, std::io::Error> {
    let bytes = fs::read(path)?;
    let hash = Sha256::digest(&bytes);
    Ok(hash.iter().map(|b| format!("{b:02x}")).collect())
}

fn detect_anticheat(dir: &Path, depth: usize) -> Option<String> {
    if depth > 4 || !dir.is_dir() {
        return None;
    }

    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_lower = name.to_string_lossy().to_lowercase();
        if ANTICHEAT_MARKERS.contains(&name_lower.as_str()) {
            return Some(name_lower);
        }

        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            if let Some(found) = detect_anticheat(&entry.path(), depth + 1) {
                return Some(found);
            }
        }
    }

    None
}

fn manifest_path(game_dir: &Path) -> PathBuf {
    game_dir.join(MANIFEST_FILENAME)
}

fn load_manifest(game_dir: &Path) -> GseManifest {
    let path = manifest_path(game_dir);
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    } else {
        GseManifest::default()
    }
}

fn save_manifest(game_dir: &Path, manifest: &GseManifest) -> Result<(), std::io::Error> {
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(manifest_path(game_dir), raw)
}

pub struct GseLaunchInterceptor;

impl Default for GseLaunchInterceptor {
    fn default() -> Self {
        Self::new()
    }
}

impl GseLaunchInterceptor {
    pub fn new() -> Self {
        Self
    }
}

impl LaunchInterceptor for GseLaunchInterceptor {
    fn id(&self) -> &'static str {
        "drop-gse"
    }

    fn pre_launch(
        &self,
        game_id: &str,
        install_dir: &Path,
        command: &mut Command,
    ) -> Result<(), ProcessError> {
        info!("GSE interceptor pre_launch check for game {}", game_id);

        // 1. Anti-cheat gate
        if let Some(marker) = detect_anticheat(install_dir, 0) {
            warn!(
                "Anti-cheat payload '{}' detected in {}. GSE patching aborted.",
                marker,
                install_dir.display()
            );
            return Err(ProcessError::FailedLaunch(format!(
                "Anti-cheat payload detected ({marker}). Multiplayer emulator patching aborted for safety."
            )));
        }

        // 2. Scan and back up target binaries
        let mut manifest = load_manifest(install_dir);
        let mut found_any = false;

        for binary in TARGET_BINARIES {
            let target_path = install_dir.join(binary);
            if target_path.is_file() {
                found_any = true;
                let backup_path = install_dir.join(format!("{binary}.orig"));

                let _live_digest = sha256_of(&target_path)?;

                if let Some(recorded) = manifest.entries.get(*binary) {
                    if let Ok(backup_digest) = sha256_of(&backup_path) {
                        if backup_digest == *recorded {
                            // Backup is verified and intact
                            continue;
                        }
                    }
                }

                // Create fresh backup
                fs::copy(&target_path, &backup_path)?;
                let backup_digest = sha256_of(&backup_path)?;
                manifest.entries.insert(binary.to_string(), backup_digest);
            }
        }

        if found_any {
            save_manifest(install_dir, &manifest)?;

            // 3. Configure steam_settings directory
            let settings_dir = install_dir.join("steam_settings");
            fs::create_dir_all(&settings_dir)?;

            let broadcasts_file = settings_dir.join("custom_broadcasts.txt");
            if !broadcasts_file.exists() {
                // Default fallback broadcast target for local/virtual mesh
                fs::write(&broadcasts_file, "127.0.0.1:47584\n")?;
            }

            // Set environment marker for child process
            command.env("DROP_GSE_ACTIVE", "1");
        }

        Ok(())
    }

    fn on_running(&self, game_id: &str, pid: u32) -> Result<(), ProcessError> {
        info!("GSE interceptor monitoring game {} (PID: {})", game_id, pid);
        Ok(())
    }

    fn post_exit(
        &self,
        game_id: &str,
        install_dir: &Path,
        exit_status: Option<i32>,
    ) -> Result<(), ProcessError> {
        info!(
            "GSE interceptor post_exit cleanup for game {} (status: {:?})",
            game_id, exit_status
        );

        let manifest = load_manifest(install_dir);

        // 1. Verify and restore original binaries
        for (binary, recorded_digest) in &manifest.entries {
            let backup_path = install_dir.join(format!("{binary}.orig"));
            let target_path = install_dir.join(binary);

            if backup_path.is_file() {
                if let Ok(actual_digest) = sha256_of(&backup_path) {
                    if actual_digest == *recorded_digest {
                        let _ = fs::copy(&backup_path, &target_path);
                    } else {
                        warn!(
                            "GSE backup digest mismatch for {}, keeping backup for safety",
                            binary
                        );
                        continue;
                    }
                }
                let _ = fs::remove_file(&backup_path);
            }
        }

        // 2. Remove manifest
        let manifest_file = manifest_path(install_dir);
        if manifest_file.exists() {
            let _ = fs::remove_file(&manifest_file);
        }

        // 3. Clean up steam_settings
        let settings_dir = install_dir.join("steam_settings");
        if settings_dir.exists() {
            let _ = fs::remove_file(settings_dir.join("custom_broadcasts.txt"));
            let _ = fs::remove_dir(&settings_dir);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("drop-gse-test-{}", name));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_anticheat_detection() {
        let dir = create_test_dir("anticheat");
        fs::write(dir.join("EasyAntiCheat.exe"), b"test").unwrap();

        let detected = detect_anticheat(&dir, 0);
        assert_eq!(detected, Some("easyanticheat.exe".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_gse_pre_launch_and_post_exit_lifecycle() {
        let dir = create_test_dir("lifecycle");
        let dll_path = dir.join("steam_api64.dll");
        fs::write(&dll_path, b"original-steam-api").unwrap();

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");

        // Pre-launch
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_ok());

        // Verify backup and settings created
        let backup_path = dir.join("steam_api64.dll.orig");
        assert!(backup_path.exists());
        assert_eq!(fs::read(&backup_path).unwrap(), b"original-steam-api");
        assert!(dir.join(MANIFEST_FILENAME).exists());
        assert!(dir.join("steam_settings").join("custom_broadcasts.txt").exists());

        // Simulate game running with patched DLL
        fs::write(&dll_path, b"patched-goldberg-dll").unwrap();

        // Post-exit
        assert!(interceptor.post_exit("game-test", &dir, Some(0)).is_ok());

        // Verify restored to original and backups cleaned up
        assert_eq!(fs::read(&dll_path).unwrap(), b"original-steam-api");
        assert!(!backup_path.exists());
        assert!(!dir.join(MANIFEST_FILENAME).exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
