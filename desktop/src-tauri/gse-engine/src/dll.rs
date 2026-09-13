//! Steam API binary backup, swap and restore.
//!
//! Originals are copied aside as `<name>.orig` before any replacement, and a
//! per-directory manifest (`.drop-gse-manifest.json`) records the SHA-256 of
//! each original. A backup is only reused or removed after its digest matches
//! the manifest — an unverified or stale backup is never trusted.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::EngineError;

/// steam_api binaries we may replace, per platform.
pub const TARGET_BINARIES: &[&str] = &["steam_api.dll", "steam_api64.dll", "libsteam_api.so"];

/// Manifest file written next to the `.orig` backups.
pub const MANIFEST_FILE: &str = ".drop-gse-manifest.json";

#[derive(Debug, Serialize, Deserialize, Default)]
struct Manifest {
    entries: BTreeMap<String, String>,
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_of(path: &Path) -> Result<String, EngineError> {
    let data = std::fs::read(path)?;
    Ok(to_hex(&Sha256::digest(&data)))
}

fn manifest_path(game_dir: &Path) -> PathBuf {
    game_dir.join(MANIFEST_FILE)
}

fn load_manifest(game_dir: &Path) -> Result<Manifest, EngineError> {
    let path = manifest_path(game_dir);
    if path.exists() {
        let raw = std::fs::read_to_string(&path)?;
        serde_json::from_str(&raw).map_err(EngineError::Serialization)
    } else {
        Ok(Manifest::default())
    }
}

fn save_manifest(game_dir: &Path, manifest: &Manifest) -> Result<(), EngineError> {
    let raw = serde_json::to_string_pretty(manifest)?;
    std::fs::write(manifest_path(game_dir), raw)?;
    Ok(())
}

fn ensure_game_dir(game_dir: &Path) -> Result<(), EngineError> {
    match std::fs::metadata(game_dir) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(EngineError::GameDirNotFound(game_dir.display().to_string())),
        Err(e) => Err(EngineError::GameDirNotFound(format!(
            "{}: {e}",
            game_dir.display()
        ))),
    }
}

/// Outcome of backing up a single binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    /// A fresh backup was created, or an intact one already existed.
    BackedUp,
    /// The live binary is patched relative to its recorded original; the
    /// verified backup was left untouched.
    AlreadyPatched,
}

/// Per-binary result of [`backup_originals`].
#[derive(Debug, Default)]
pub struct BackupOutcome {
    pub states: BTreeMap<String, BackupState>,
}

impl BackupOutcome {
    pub fn state(&self, name: &str) -> Option<BackupState> {
        self.states.get(name).copied()
    }
}

/// Back up `binaries` inside `game_dir` as `<name>.orig`.
pub fn backup_originals(
    game_dir: &Path,
    binaries: &[&str],
) -> Result<BackupOutcome, EngineError> {
    ensure_game_dir(game_dir)?;
    let mut manifest = load_manifest(game_dir)?;
    let mut outcome = BackupOutcome::default();

    for name in binaries {
        let src = game_dir.join(name);
        if !std::fs::metadata(&src).map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let dst = game_dir.join(format!("{name}.orig"));
        let live_digest = sha256_of(&src)?;

        match manifest.entries.get(*name) {
            Some(recorded) => match sha256_of(&dst) {
                Ok(d) if d == *recorded && live_digest == *recorded => {
                    outcome.states.insert(name.to_string(), BackupState::BackedUp);
                }
                Ok(d) if d == *recorded => {
                    // Verified backup + modified live file: preserve original.
                    outcome
                        .states
                        .insert(name.to_string(), BackupState::AlreadyPatched);
                }
                _ => {
                    std::fs::copy(&src, &dst)?;
                    manifest
                        .entries
                        .insert(name.to_string(), sha256_of(&dst)?);
                    outcome.states.insert(name.to_string(), BackupState::BackedUp);
                }
            },
            None => {
                std::fs::copy(&src, &dst)?;
                manifest
                    .entries
                    .insert(name.to_string(), sha256_of(&dst)?);
                outcome.states.insert(name.to_string(), BackupState::BackedUp);
            }
        }
    }

    save_manifest(game_dir, &manifest)?;
    Ok(outcome)
}

/// Restore `*.orig` backups created by [`backup_originals`] and remove them.
///
/// Phases: verify every tracked backup, copy them back, then remove each
/// backup and persist progress after each removal so an interruption resumes.
pub fn restore_originals(game_dir: &Path, binaries: &[&str]) -> Result<(), EngineError> {
    ensure_game_dir(game_dir)?;
    let mut manifest = load_manifest(game_dir)?;

    for name in binaries {
        let Some(recorded) = manifest.entries.get(*name) else {
            continue;
        };
        let src = game_dir.join(format!("{name}.orig"));
        let found = sha256_of(&src).map_err(|_| EngineError::ManifestMismatch {
            path: name.to_string(),
            expected: recorded.clone(),
            found: "<backup missing>".to_string(),
        })?;
        if found != *recorded {
            return Err(EngineError::ManifestMismatch {
                path: name.to_string(),
                expected: recorded.clone(),
                found,
            });
        }
    }

    for name in binaries {
        if !manifest.entries.contains_key(*name) {
            continue;
        }
        std::fs::copy(
            game_dir.join(format!("{name}.orig")),
            game_dir.join(name),
        )?;
    }

    for name in binaries {
        if !manifest.entries.contains_key(*name) {
            continue;
        }
        std::fs::remove_file(game_dir.join(format!("{name}.orig")))?;
        manifest.entries.remove(*name);
        save_manifest(game_dir, &manifest)?;
    }

    // Remove an empty manifest once fully restored.
    let path = manifest_path(game_dir);
    if manifest.entries.is_empty() && path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_restore_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();

        let outcome = backup_originals(dir, TARGET_BINARIES).unwrap();
        assert_eq!(outcome.state("steam_api64.dll"), Some(BackupState::BackedUp));
        assert!(dir.join("steam_api64.dll.orig").exists());

        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        restore_originals(dir, TARGET_BINARIES).unwrap();

        assert_eq!(std::fs::read(dir.join("steam_api64.dll")).unwrap(), b"original");
        assert!(!dir.join("steam_api64.dll.orig").exists());
        assert!(!dir.join(MANIFEST_FILE).exists());
    }

    #[test]
    fn second_run_preserves_backup_of_patched_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();

        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        let outcome = backup_originals(dir, &["steam_api64.dll"]).unwrap();
        assert_eq!(
            outcome.state("steam_api64.dll"),
            Some(BackupState::AlreadyPatched)
        );
        assert_eq!(
            std::fs::read(dir.join("steam_api64.dll.orig")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn tampered_backup_aborts_restore() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("steam_api64.dll"), b"original").unwrap();
        backup_originals(dir, &["steam_api64.dll"]).unwrap();
        std::fs::write(dir.join("steam_api64.dll"), b"patched").unwrap();
        std::fs::write(dir.join("steam_api64.dll.orig"), b"tampered").unwrap();

        let err = restore_originals(dir, &["steam_api64.dll"]).unwrap_err();
        assert!(matches!(err, EngineError::ManifestMismatch { .. }));
        assert_eq!(std::fs::read(dir.join("steam_api64.dll")).unwrap(), b"patched");
    }
}
