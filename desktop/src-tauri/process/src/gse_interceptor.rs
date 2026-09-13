use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use gse_engine::dll::{MANIFEST_FILE, TARGET_BINARIES, backup_originals, tracked_binaries};
use gse_engine::{EmulatorFlavor, PatchPlan, anticheat, apply_plan, restore, scanner};
use log::{info, warn};

use crate::{error::ProcessError, interceptor::LaunchInterceptor};

/// Default LAN discovery target when no mesh peers are configured.
const DEFAULT_BROADCAST: &str = "127.0.0.1:47584\n";

/// Env var that force-enables GSE for a launch even without a room config.
const FORCE_ENV: &str = "DROP_GSE_ENABLE";

fn gse_error(context: &str, err: gse_engine::EngineError) -> ProcessError {
    ProcessError::FailedLaunch(format!("{context}: {err}"))
}

/// Whether GSE should run for this launch.
///
/// GSE is opt-in per launch: it activates only when a room config was written
/// (`steam_settings/custom_broadcasts.txt`, produced by `gse_write_room_config`)
/// or when `DROP_GSE_ENABLE` is set. This keeps anti-cheat gating and install
/// mutation away from ordinary launches.
fn gse_requested(install_dir: &Path) -> bool {
    std::env::var_os(FORCE_ENV).is_some()
        || install_dir
            .join("steam_settings/custom_broadcasts.txt")
            .is_file()
}

/// Restore Steam API binaries left backed up by interrupted sessions (crash
/// recovery). Returns the number of game directories recovered.
pub fn recover_interrupted_sessions(install_dirs: &[PathBuf]) -> usize {
    let mut recovered = 0;
    for dir in install_dirs {
        if !dir.join(MANIFEST_FILE).is_file() {
            continue;
        }

        // Include every target the manifest tracks (nested paths included),
        // plus the default names in case the original was replaced/removed.
        let mut targets: Vec<String> = TARGET_BINARIES
            .iter()
            .map(|name| (*name).to_string())
            .collect();
        match tracked_binaries(dir) {
            Ok(tracked) => {
                for name in tracked {
                    if !targets.contains(&name) {
                        targets.push(name);
                    }
                }
            }
            Err(err) => warn!(
                "GSE crash recovery could not read the manifest for {}: {err}",
                dir.display()
            ),
        }

        match restore(dir, &targets) {
            Ok(()) => {
                recovered += 1;
                info!("GSE crash recovery restored originals in {}", dir.display());
            }
            Err(err) => warn!("GSE crash recovery failed for {}: {err}", dir.display()),
        }
    }
    recovered
}

/// Read the pinned AppID, if `gse_write_room_config` wrote one.
fn read_app_id(install_dir: &Path) -> u32 {
    std::fs::read_to_string(install_dir.join("steam_settings/steam_appid.txt"))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Read room peer addresses written by `gse_write_room_config`.
fn read_broadcast_peers(install_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(install_dir.join("steam_settings/custom_broadcasts.txt"))
        .map(|content| {
            content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Read the room's emulator flavor written by `gse_write_room_config`,
/// defaulting to the Goldberg fork.
fn read_flavor(install_dir: &Path) -> EmulatorFlavor {
    match std::fs::read_to_string(install_dir.join("steam_settings/drop_gse_flavor.txt"))
        .ok()
        .map(|value| value.trim().to_string())
        .as_deref()
    {
        Some("gse_fork") => EmulatorFlavor::GseFork,
        _ => EmulatorFlavor::GbeFork,
    }
}

/// Staged emulator payload location for a flavor under Drop's data directory.
fn default_payload_dir(flavor: EmulatorFlavor) -> Option<PathBuf> {
    let name = match flavor {
        EmulatorFlavor::GbeFork => "gbe_fork",
        EmulatorFlavor::GseFork => "gse_fork",
    };
    let dir = database::db::DATA_ROOT_DIR.join("tools/gse").join(name);
    dir.is_dir().then_some(dir)
}

/// Interceptor that manages the Goldberg-family Steam emulator lifecycle around
/// a launch. Patching, backup/restore and anti-cheat detection are delegated to
/// the tested `gse-engine` crate.
pub struct GseLaunchInterceptor {
    /// Explicit payload override (tests / release manager). When `None`, the
    /// payload directory is resolved per launch from the room's emulator flavor.
    payload_override: Option<PathBuf>,
    /// Games whose current launch actually activated GSE. `post_exit` only
    /// restores/cleans when the launch is in this set, so an ordinary launch
    /// never deletes a player's pre-existing `steam_settings/`.
    active: Mutex<HashSet<String>>,
}

impl Default for GseLaunchInterceptor {
    fn default() -> Self {
        Self::new()
    }
}

impl GseLaunchInterceptor {
    /// Resolve the staged payload from the room's flavor at launch time.
    pub fn new() -> Self {
        Self {
            payload_override: None,
            active: Mutex::new(HashSet::new()),
        }
    }

    /// Construct with an explicit payload directory (tests / release manager).
    pub fn with_payload_dir(payload_dir: Option<PathBuf>) -> Self {
        Self {
            payload_override: payload_dir,
            active: Mutex::new(HashSet::new()),
        }
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

        // 0. Opt-in gate: ordinary launches are completely untouched.
        if !gse_requested(install_dir) {
            info!("GSE not requested for {}; skipping emulator setup", game_id);
            return Ok(());
        }

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

        // 2. Find Steam API targets (relative paths, possibly nested).
        let targets: Vec<String> = scanner::find_targets(install_dir)
            .map_err(|err| gse_error("failed to scan for Steam API binaries", err))?
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        if targets.is_empty() {
            info!(
                "no Steam API binaries found for {}; skipping GSE setup",
                game_id
            );
            return Ok(());
        }

        // 3. Apply the staged emulator payload when present; otherwise only back
        //    up originals and seed a LAN broadcast file (offline/no-payload mode).
        let flavor = read_flavor(install_dir);
        let payload_dir = self
            .payload_override
            .clone()
            .or_else(|| default_payload_dir(flavor));
        match &payload_dir {
            Some(payload) => {
                let plan = PatchPlan {
                    flavor,
                    app_id: read_app_id(install_dir),
                    targets,
                    broadcast_peers: read_broadcast_peers(install_dir),
                };
                apply_plan(&plan, install_dir, payload)
                    .map_err(|err| gse_error("failed to apply GSE emulator payload", err))?;
            }
            None => {
                let refs: Vec<&str> = targets.iter().map(String::as_str).collect();
                backup_originals(install_dir, &refs)
                    .map_err(|err| gse_error("failed to back up Steam API binaries", err))?;
                let settings_dir = install_dir.join("steam_settings");
                std::fs::create_dir_all(&settings_dir).map_err(ProcessError::from)?;
                let broadcasts = settings_dir.join("custom_broadcasts.txt");
                if !broadcasts.exists() {
                    std::fs::write(&broadcasts, DEFAULT_BROADCAST).map_err(ProcessError::from)?;
                }
            }
        }

        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(game_id.to_string());
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

        // Only restore/clean when this specific launch activated GSE. Without
        // this gate, an ordinary launch whose install dir has no room marker
        // still reached the cleanup below and deleted a player's own
        // `steam_settings/`.
        let activated = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(game_id);
        if !activated {
            info!(
                "GSE was not active for {}; skipping restore/cleanup",
                game_id
            );
            return Ok(());
        }

        // Restore in reverse order of mutation: current targets plus the
        // default names (in case the original was replaced and then removed).
        let mut targets: Vec<String> = scanner::find_targets(install_dir)
            .map(|paths| {
                paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        for name in TARGET_BINARIES {
            if !targets.iter().any(|target| target == name) {
                targets.push((*name).to_string());
            }
        }

        if let Err(err) = restore(install_dir, &targets) {
            warn!(
                "GSE restore failed for {}: {err}; backups left in place for the next launch",
                game_id
            );
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

    fn mark_room_requested(dir: &Path) {
        let settings = dir.join("steam_settings");
        std::fs::create_dir_all(&settings).unwrap();
        std::fs::write(settings.join("custom_broadcasts.txt"), "10.0.0.2:47584\n").unwrap();
    }

    #[test]
    fn reads_the_room_emulator_flavor() {
        let dir = create_test_dir("flavor");
        let settings = dir.join("steam_settings");
        std::fs::create_dir_all(&settings).unwrap();

        // Missing file defaults to the Goldberg fork.
        assert_eq!(read_flavor(&dir), EmulatorFlavor::GbeFork);

        std::fs::write(settings.join("drop_gse_flavor.txt"), "gse_fork\n").unwrap();
        assert_eq!(read_flavor(&dir), EmulatorFlavor::GseFork);

        // Unknown values must not select a payload directory.
        std::fs::write(settings.join("drop_gse_flavor.txt"), "garbage").unwrap();
        assert_eq!(read_flavor(&dir), EmulatorFlavor::GbeFork);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ordinary_launch_is_untouched_without_a_room() {
        let dir = create_test_dir("not-opted-in");
        std::fs::write(dir.join("steam_api64.dll"), b"original-steam-api").unwrap();

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_ok());

        // No backup, no settings written.
        assert!(!dir.join("steam_api64.dll.orig").exists());
        assert!(!dir.join("steam_settings/configs.main.ini").exists());

        // post_exit must not touch a player's own settings on a launch that
        // never activated GSE.
        let settings = dir.join("steam_settings");
        std::fs::create_dir_all(&settings).unwrap();
        std::fs::write(settings.join("configs.main.ini"), "user-config").unwrap();
        std::fs::write(settings.join("steam_appid.txt"), "480").unwrap();

        assert!(interceptor.post_exit("game-test", &dir, Some(0)).is_ok());
        assert_eq!(
            std::fs::read_to_string(settings.join("configs.main.ini")).unwrap(),
            "user-config"
        );
        assert_eq!(
            std::fs::read_to_string(settings.join("steam_appid.txt")).unwrap(),
            "480"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn applies_staged_payload_and_restores() {
        let dir = create_test_dir("payload");
        std::fs::write(dir.join("steam_api64.dll"), b"original-valve").unwrap();
        mark_room_requested(&dir);

        let payload = create_test_dir("payload-src");
        std::fs::write(payload.join("steam_api64.dll"), b"goldberg-patched").unwrap();

        let interceptor = GseLaunchInterceptor::with_payload_dir(Some(payload.clone()));
        let mut cmd = Command::new("echo");
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_ok());

        // The emulator payload replaced the DLL and the original was backed up.
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll")).unwrap(),
            b"goldberg-patched"
        );
        assert!(dir.join("steam_api64.dll.orig").exists());

        assert!(interceptor.post_exit("game-test", &dir, Some(0)).is_ok());
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll")).unwrap(),
            b"original-valve"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&payload);
    }

    #[test]
    fn crash_recovery_restores_nested_targets_and_clears_the_marker() {
        let dir = create_test_dir("nested-recovery");
        let nested = dir.join("bin/x64");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("steam_api64.dll"), b"original-valve").unwrap();
        mark_room_requested(&dir);
        std::fs::write(dir.join("steam_settings/steam_appid.txt"), "440").unwrap();

        // Simulate an interrupted session: verified backup + manifest, patched
        // live binary, room marker still present.
        backup_originals(&dir, &["bin/x64/steam_api64.dll"]).unwrap();
        std::fs::write(nested.join("steam_api64.dll"), b"patched").unwrap();

        let recovered = recover_interrupted_sessions(&[dir.clone()]);
        assert_eq!(recovered, 1);
        assert_eq!(
            std::fs::read(nested.join("steam_api64.dll")).unwrap(),
            b"original-valve"
        );
        assert!(!nested.join("steam_api64.dll.orig").exists());
        assert!(!dir.join("steam_settings/custom_broadcasts.txt").exists());
        assert!(!dir.join("steam_settings/steam_appid.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn anticheat_detection_blocks_launch() {
        let dir = create_test_dir("anticheat");
        mark_room_requested(&dir);
        std::fs::write(dir.join("EasyAntiCheat.exe"), b"test").unwrap();

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_launch_and_post_exit_lifecycle() {
        let dir = create_test_dir("lifecycle");
        let dll_path = dir.join("steam_api64.dll");
        std::fs::write(&dll_path, b"original-steam-api").unwrap();
        mark_room_requested(&dir);

        let interceptor = GseLaunchInterceptor::new();
        let mut cmd = Command::new("echo");
        assert!(interceptor.pre_launch("game-test", &dir, &mut cmd).is_ok());

        assert!(dir.join("steam_api64.dll.orig").exists());
        assert!(dir.join(MANIFEST_FILE).exists());
        assert!(dir.join("steam_settings/custom_broadcasts.txt").exists());

        // Simulate the emulator replacing the DLL while the game runs.
        std::fs::write(&dll_path, b"patched-goldberg-dll").unwrap();

        assert!(interceptor.post_exit("game-test", &dir, Some(0)).is_ok());

        assert_eq!(std::fs::read(&dll_path).unwrap(), b"original-steam-api");
        assert!(!dir.join("steam_api64.dll.orig").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
