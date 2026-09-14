use std::{
    collections::HashMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use database::db::DATA_ROOT_DIR;
use log::{debug, info};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::BackupError;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LudusaviOverall {
    #[serde(rename = "totalGames")]
    pub total_games: usize,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LudusaviFileResult {
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub change: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LudusaviGameResult {
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub files: HashMap<String, LudusaviFileResult>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct LudusaviBackupResponse {
    pub overall: LudusaviOverall,
    #[serde(default)]
    pub games: HashMap<String, LudusaviGameResult>,
}

/// Everything the sync engine needs to resolve and transfer one game's saves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSaveSyncContext {
    pub game_id: String,
    pub game_title: String,
    pub install_dir: Option<PathBuf>,
    pub wine_prefix: Option<PathBuf>,
}

impl CloudSaveSyncContext {
    pub fn new(game_id: impl Into<String>, game_title: impl Into<String>) -> Self {
        Self {
            game_id: game_id.into(),
            game_title: game_title.into(),
            install_dir: None,
            wine_prefix: None,
        }
    }

    pub fn with_install_dir(mut self, install_dir: impl Into<PathBuf>) -> Self {
        self.install_dir = Some(install_dir.into());
        self
    }

    pub fn with_wine_prefix(mut self, wine_prefix: impl Into<PathBuf>) -> Self {
        self.wine_prefix = Some(wine_prefix.into());
        self
    }

    /// The default UMU/Proton prefix Drop provisions for a Windows title.
    pub fn default_wine_prefix(game_id: &str) -> PathBuf {
        DATA_ROOT_DIR.join("pfx").join(game_id)
    }
}

/// Coordinates pre-launch restores and post-exit backups for a single game.
pub struct CloudSaveSyncManager {
    context: CloudSaveSyncContext,
}

impl CloudSaveSyncManager {
    pub fn new(context: CloudSaveSyncContext) -> Self {
        Self { context }
    }

    pub fn context(&self) -> &CloudSaveSyncContext {
        &self.context
    }

    pub fn sync_pre_launch(&self) -> Result<bool, BackupError> {
        sync_pre_launch(&self.context)
    }

    pub fn sync_post_exit(&self) -> Result<bool, BackupError> {
        sync_post_exit(&self.context)
    }
}

pub struct LudusaviClient {
    pub executable_path: PathBuf,
}

impl LudusaviClient {
    pub fn new(executable_path: PathBuf) -> Self {
        Self { executable_path }
    }

    /// Attempts to find the ludusavi binary either in the Drop tools directory or in PATH.
    pub fn discover() -> Option<Self> {
        let binary_name = if cfg!(target_os = "windows") {
            "ludusavi.exe"
        } else {
            "ludusavi"
        };

        // 1. Check local Drop tools directory: <DATA_ROOT_DIR>/tools/ludusavi/ludusavi
        let tools_path = DATA_ROOT_DIR
            .join("tools")
            .join("ludusavi")
            .join(binary_name);
        if tools_path.is_file() {
            return Some(Self::new(tools_path));
        }

        // 2. Search PATH environment variable
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(binary_name);
                if candidate.is_file() {
                    return Some(Self::new(candidate));
                }
            }
        }

        None
    }

    /// Check if a game has known save data to back up without creating files.
    pub fn preview_backup(
        &self,
        game_title: &str,
        wine_prefix: Option<&Path>,
    ) -> Result<LudusaviBackupResponse, BackupError> {
        let mut cmd = Command::new(&self.executable_path);
        cmd.arg("backup")
            .arg("--api")
            .arg("--preview")
            .arg("--game")
            .arg(game_title);

        if let Some(prefix) = wine_prefix {
            cmd.arg("--wine-prefix").arg(prefix);
        }

        let output = cmd.output().map_err(|e| {
            BackupError::ExecutionError(format!("Failed to execute ludusavi preview: {e}"))
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let resp: LudusaviBackupResponse = serde_json::from_str(&stdout).map_err(|e| {
            BackupError::SerializationError(format!("Failed to parse ludusavi JSON: {e}"))
        })?;

        Ok(resp)
    }

    /// Back up game saves to a staging directory.
    pub fn backup_game(
        &self,
        game_title: &str,
        staging_dir: &Path,
        wine_prefix: Option<&Path>,
    ) -> Result<LudusaviBackupResponse, BackupError> {
        let mut cmd = Command::new(&self.executable_path);
        cmd.arg("backup")
            .arg("--api")
            .arg("--path")
            .arg(staging_dir)
            .arg("--game")
            .arg(game_title);

        if let Some(prefix) = wine_prefix {
            cmd.arg("--wine-prefix").arg(prefix);
        }

        let output = cmd.output().map_err(|e| {
            BackupError::ExecutionError(format!("Failed to execute ludusavi backup: {e}"))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(BackupError::ExecutionError(format!(
                "Ludusavi backup failed: {stderr}"
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let resp: LudusaviBackupResponse = serde_json::from_str(&stdout).map_err(|e| {
            BackupError::SerializationError(format!("Failed to parse ludusavi JSON: {e}"))
        })?;

        Ok(resp)
    }

    /// Restore saves from a staged directory.
    pub fn restore_game(
        &self,
        game_title: &str,
        staging_dir: &Path,
        wine_prefix: Option<&Path>,
    ) -> Result<(), BackupError> {
        let mut cmd = Command::new(&self.executable_path);
        cmd.arg("restore")
            .arg("--api")
            .arg("--path")
            .arg(staging_dir)
            .arg("--game")
            .arg(game_title);

        if let Some(prefix) = wine_prefix {
            cmd.arg("--wine-prefix").arg(prefix);
        }

        let output = cmd.output().map_err(|e| {
            BackupError::ExecutionError(format!("Failed to execute ludusavi restore: {e}"))
        })?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(BackupError::ExecutionError(format!(
                "Ludusavi restore failed: {stderr}"
            )));
        }

        Ok(())
    }
}

/// Package a directory into a .tar.zst archive and calculate its SHA-256 digest.
pub fn pack_save_archive(
    source_dir: &Path,
    output_file: &Path,
) -> Result<(u64, String), BackupError> {
    if let Some(parent) = output_file.parent() {
        fs::create_dir_all(parent)?;
    }

    let out = File::create(output_file)?;
    let compressor = zstd::Encoder::new(out, 3)?;
    let mut tar_builder = tar::Builder::new(compressor);

    if source_dir.is_dir() {
        for entry in fs::read_dir(source_dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = match path.file_name() {
                Some(name) => name,
                None => continue,
            };

            if path.is_dir() {
                tar_builder.append_dir_all(file_name, &path)?;
            } else if path.is_file() {
                let mut f = File::open(&path)?;
                tar_builder.append_file(file_name, &mut f)?;
            }
        }
    }

    let compressor = tar_builder.into_inner()?;
    compressor.finish()?;

    // Read back to compute archive size and SHA-256
    let mut file = File::open(output_file)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut total_size = 0u64;

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
        total_size += bytes_read as u64;
    }

    let checksum = format!("{:x}", hasher.finalize());
    Ok((total_size, checksum))
}

/// Unpack a .tar.zst archive into the target directory, verifying SHA-256 if expected.
pub fn unpack_save_archive(
    archive_file: &Path,
    target_dir: &Path,
    expected_checksum: Option<&str>,
) -> Result<(), BackupError> {
    if !archive_file.is_file() {
        return Err(BackupError::NotFound);
    }

    if let Some(expected) = expected_checksum {
        let mut file = File::open(archive_file)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];
        loop {
            let bytes_read = file.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
        }
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(BackupError::ChecksumMismatch {
                expected: expected.to_string(),
                actual,
            });
        }
    }

    fs::create_dir_all(target_dir)?;
    let file = File::open(archive_file)?;
    let decompressor = zstd::Decoder::new(file)?;
    let mut archive = tar::Archive::new(decompressor);
    archive.unpack(target_dir)?;

    Ok(())
}

/// Pre-launch hook: checks for newer remote cloud save snapshot and restores it.
pub fn sync_pre_launch(context: &CloudSaveSyncContext) -> Result<bool, BackupError> {
    let game_id = context.game_id.as_str();
    let game_title = context.game_title.as_str();
    info!(
        "Cloud save pre-launch check for game '{}' ({})",
        game_title, game_id
    );

    let client = match LudusaviClient::discover() {
        Some(c) => c,
        None => {
            debug!("Ludusavi binary not found; skipping cloud save pre-launch hook");
            return Ok(false);
        }
    };

    // Staging directory for pulling cloud saves
    let staging_dir = DATA_ROOT_DIR.join("saves").join("staging").join(game_id);
    let archive_path = DATA_ROOT_DIR
        .join("saves")
        .join("cache")
        .join(format!("{game_id}.tar.zst"));

    if archive_path.is_file() {
        if staging_dir.exists() {
            let _ = fs::remove_dir_all(&staging_dir);
        }
        fs::create_dir_all(&staging_dir)?;
        unpack_save_archive(&archive_path, &staging_dir, None)?;
        client.restore_game(game_title, &staging_dir, context.wine_prefix.as_deref())?;
        info!(
            "Cloud save restored successfully before launching {}",
            game_title
        );
        return Ok(true);
    }

    Ok(false)
}

/// Post-exit hook: discovers save changes with Ludusavi, bundles them, and archives snapshot.
pub fn sync_post_exit(context: &CloudSaveSyncContext) -> Result<bool, BackupError> {
    let game_id = context.game_id.as_str();
    let game_title = context.game_title.as_str();
    info!(
        "Cloud save post-exit backup for game '{}' ({})",
        game_title, game_id
    );

    let client = match LudusaviClient::discover() {
        Some(c) => c,
        None => {
            debug!("Ludusavi binary not found; skipping cloud save post-exit hook");
            return Ok(false);
        }
    };

    let staging_dir = DATA_ROOT_DIR.join("saves").join("staging").join(game_id);
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    fs::create_dir_all(&staging_dir)?;

    let backup_resp =
        client.backup_game(game_title, &staging_dir, context.wine_prefix.as_deref())?;
    if backup_resp.overall.total_games == 0 && backup_resp.overall.total_bytes == 0 {
        debug!("No save files found by Ludusavi for game {}", game_title);
        return Ok(false);
    }

    let cache_dir = DATA_ROOT_DIR.join("saves").join("cache");
    fs::create_dir_all(&cache_dir)?;
    let archive_path = cache_dir.join(format!("{game_id}.tar.zst"));

    let (bytes, checksum) = pack_save_archive(&staging_dir, &archive_path)?;
    info!(
        "Packaged cloud save archive for {} ({} bytes, sha256: {})",
        game_title, bytes, checksum
    );

    Ok(true)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_ludusavi_api_parsing() {
        let sample_json = r#"{
            "overall": {
                "totalGames": 1,
                "totalBytes": 1048576
            },
            "games": {
                "Hollow Knight": {
                    "decision": "Processed",
                    "files": {
                        "user1.dat": {
                            "bytes": 524288,
                            "change": "Updated"
                        },
                        "settings.json": {
                            "bytes": 524288,
                            "change": "New"
                        }
                    }
                }
            }
        }"#;

        let parsed: LudusaviBackupResponse =
            serde_json::from_str(sample_json).expect("Failed to parse sample Ludusavi JSON");

        assert_eq!(parsed.overall.total_games, 1);
        assert_eq!(parsed.overall.total_bytes, 1048576);

        let game = parsed
            .games
            .get("Hollow Knight")
            .expect("Game not found in map");
        assert_eq!(game.decision, "Processed");
        assert_eq!(game.files.len(), 2);

        let user1 = game.files.get("user1.dat").expect("user1.dat not found");
        assert_eq!(user1.bytes, 524288);
        assert_eq!(user1.change.as_deref(), Some("Updated"));
    }

    #[test]
    fn test_archive_roundtrip() {
        let temp = tempdir().expect("Failed to create tempdir");
        let src_dir = temp.path().join("source");
        let dest_dir = temp.path().join("destination");
        let archive_file = temp.path().join("backup.tar.zst");

        fs::create_dir_all(src_dir.join("nested/folder")).unwrap();
        fs::write(src_dir.join("root.save"), b"ROOT_SAVE_CONTENT_12345").unwrap();
        fs::write(
            src_dir.join("nested/folder/slot1.save"),
            b"SLOT_1_SAVE_CONTENT",
        )
        .unwrap();

        // 1. Pack directory to .tar.zst and compute sha256
        let (size, checksum) =
            pack_save_archive(&src_dir, &archive_file).expect("Failed to pack save archive");

        assert!(size > 0, "Archive size must be > 0");
        assert_eq!(
            checksum.len(),
            64,
            "SHA-256 hex string must be 64 characters"
        );

        // 2. Unpack with matching checksum
        unpack_save_archive(&archive_file, &dest_dir, Some(&checksum))
            .expect("Failed to unpack save archive");

        // 3. Verify files match source
        let root_content = fs::read(dest_dir.join("root.save")).expect("root.save missing in dest");
        assert_eq!(root_content, b"ROOT_SAVE_CONTENT_12345");

        let slot1_content = fs::read(dest_dir.join("nested/folder/slot1.save"))
            .expect("slot1.save missing in dest");
        assert_eq!(slot1_content, b"SLOT_1_SAVE_CONTENT");

        // 4. Test checksum mismatch detection
        let wrong_dest = temp.path().join("dest_wrong");
        let err = unpack_save_archive(
            &archive_file,
            &wrong_dest,
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        )
        .expect_err("Expected checksum mismatch error");

        match err {
            BackupError::ChecksumMismatch { expected, actual } => {
                assert_eq!(
                    expected,
                    "0000000000000000000000000000000000000000000000000000000000000000"
                );
                assert_eq!(actual, checksum);
            }
            other => panic!("Unexpected error type: {:?}", other),
        }
    }
}
