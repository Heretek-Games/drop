use std::{path::Path, process::Command};

use gse_engine::anticheat;
use gse_engine::dll::{MANIFEST_FILE, TARGET_BINARIES, backup_originals, restore_originals};
use log::{info, warn};

use crate::{error::ProcessError, interceptor::LaunchInterceptor};

/// Default LAN discovery target when no mesh peers are configured.
const DEFAULT_BROADCAST: &str = "127.0.0.1:47584\n";

fn gse_error(context: &str, err: gse_engine::EngineError) -> ProcessError {
    ProcessError::FailedLaunch(format!("{context}: {err}"))
}

/// Interceptor that manages the Goldberg-family Steam emulator lifecycle around
/// a launch. Backup/restore and anti-cheat detection are delegated to the
/// tested `gse-engine` crate.
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
        info!("GSE interceptor pre_launch for game {}", game_id);

        // 1. Anti-cheat gate (fail closed).
        match anticheat::detect(install_dir) {
            Ok(Some(marker)) => {
                warn!(
                    "Anti-cheat payload '{}' detected in {}. GSE patching aborted.",
                    marker,
                    install_dir.display()
                );
                return Err(ProcessError::FailedLaunch(format!(
                    "anti-cheat payload detected ({marker}); multiplayer emulator patching aborted for safety"
                )));
            }
            Ok(None) => {}
            Err(err) => return Err(gse_error("anti-cheat scan failed", err)),
        }

        // 2. Back up target binaries that exist in this layout.
        let targets: Vec<&str> = TARGET_BINARIES
            .iter()
            .copied()
            .filter(|binary| install_dir.join(binary).is_file())
            .collect();
        if targets.is_empty() {
            info!("no Steam API binaries found for {}; skipping GSE setup", game_id);
            return Ok(());
        }
        backup_originals(install_dir, &targets)
            .map_err(|err| gse_error("failed to back up Steam API binaries", err))?;

        // 3. Preserve a room-provided broadcast config; seed a LAN default only
        //    when none exists.
        let settings_dir = install_dir.join("steam_settings");
        std::fs::create_dir_all(&settings_dir).map_err(ProcessError::from)?;
        let broadcasts = settings_dir.join("custom_broadcasts.txt");
        if !broadcasts.exists() {
            std::fs::write(&broadcasts, DEFAULT_BROADCAST).map_err(ProcessError::from)?;
        }

        command.env("DROP_GSE_ACTIVE", "1");
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
            "GSE interceptor post_exit for game {} (status: {:?})",
            game_id, exit_status
        );

        // Restore in reverse order of mutation.
        let targets: Vec<&str> = TARGET_BINARIES.to_vec();
        if let Err(err) = restore_originals(install_dir, &targets) {
            warn!(
                "GSE restore failed for {}: {err}; backups left in place for the next launch",
                game_id
            );
        }

        let settings_dir = install_dir.join("steam_settings");
        if settings_dir.exists() {
            let _ = std::fs::remove_file(settings_dir.join("custom_broadcasts.txt"));
            let _ = std::fs::remove_dir(&settings_dir);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("drop-gse-test-{name}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn anticheat_detection_blocks_launch() {
        let dir = create_test_dir("anticheat");
        std::fs::write(dir.join("EasyAntiCheat.exe"), b"test").unwrap();

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");
        assert!(
            interceptor
                .pre_launch("game-test", &dir, &mut cmd)
                .is_err()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_launch_and_post_exit_lifecycle() {
        let dir = create_test_dir("lifecycle");
        let dll_path = dir.join("steam_api64.dll");
        std::fs::write(&dll_path, b"original-steam-api").unwrap();

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_ok());

        assert!(dir.join("steam_api64.dll.orig").exists());
        assert!(dir.join(MANIFEST_FILE).exists());
        assert!(dir.join("steam_settings/custom_broadcasts.txt").exists());

        // Simulate the emulator replacing the DLL while the game runs.
        std::fs::write(&dll_path, b"patched-goldberg-dll").unwrap();

        assert!(interceptor.post_exit("game-test", &dir, Some(0)).is_ok());

        assert_eq!(
            std::fs::read(&dll_path).unwrap(),
            b"original-steam-api"
        );
        assert!(!dir.join("steam_api64.dll.orig").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
