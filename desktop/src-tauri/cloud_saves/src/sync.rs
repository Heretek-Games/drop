use std::fs;
use std::path::PathBuf;

use log::{info, warn};

use database::db::DATA_ROOT_DIR;

use crate::error::BackupError;
use crate::ludusavi::{
    CloudSaveSyncContext, LudusaviClient, backup_saves_to_cache, cache_archive_path, sha256_file,
    unpack_save_archive,
};
use crate::transport::CloudSaveTransport;

/// Slot index used by the automatic Steam-Cloud-style sync.
pub const DEFAULT_SLOT: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    NoOp,
    Pulled,
    Pushed,
    ConflictArchived,
}

/// Outcome of comparing the remote snapshot against local state before launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreLaunchDecision {
    /// Local cache already matches the remote snapshot.
    Skip,
    /// Remote is newer and local has no unsynced changes: fast-forward.
    Pull,
    /// Local was played offline and diverged from the remote snapshot.
    Conflict,
}

/// Pure conflict decision: safe forking (keep local) when the local cache has
/// unsynced changes, otherwise fast-forward to the remote snapshot.
pub fn decide_pre_launch(
    remote_checksum: &str,
    cache_checksum: Option<&str>,
    last_uploaded_checksum: Option<&str>,
) -> PreLaunchDecision {
    if cache_checksum == Some(remote_checksum) {
        return PreLaunchDecision::Skip;
    }

    let local_dirty = match (cache_checksum, last_uploaded_checksum) {
        (Some(current), Some(last)) => current != last,
        (Some(_), None) => true,
        _ => false,
    };

    if local_dirty {
        PreLaunchDecision::Conflict
    } else {
        PreLaunchDecision::Pull
    }
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct LocalSyncState {
    last_uploaded_checksum: Option<String>,
}

fn state_path(game_id: &str) -> PathBuf {
    DATA_ROOT_DIR
        .join("saves")
        .join("state")
        .join(format!("{game_id}.json"))
}

fn read_state(game_id: &str) -> LocalSyncState {
    fs::read_to_string(state_path(game_id))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_state(game_id: &str, state: &LocalSyncState) -> Result<(), BackupError> {
    let path = state_path(game_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string(state)?)?;
    Ok(())
}

fn rollback_path(game_id: &str) -> PathBuf {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    DATA_ROOT_DIR
        .join("saves")
        .join("rollback")
        .join(format!("{game_id}-{timestamp}.tar.zst"))
}

/// Pre-launch sync against the server, applying the hybrid conflict policy:
/// auto-archive the remote snapshot into a timestamped rollback when the local
/// cache has unsynced changes (the UI surfaces the conflict), otherwise pull
/// and restore the remote snapshot.
pub fn sync_pre_launch_with(
    transport: &dyn CloudSaveTransport,
    context: &CloudSaveSyncContext,
    slot: u32,
) -> Result<SyncAction, BackupError> {
    let Some(remote) = transport.fetch_latest_snapshot(&context.game_id, slot)? else {
        return Ok(SyncAction::NoOp);
    };

    let cache = cache_archive_path(&context.game_id);
    let cache_checksum = if cache.is_file() {
        Some(sha256_file(&cache)?)
    } else {
        None
    };
    let state = read_state(&context.game_id);

    match decide_pre_launch(
        &remote.checksum,
        cache_checksum.as_deref(),
        state.last_uploaded_checksum.as_deref(),
    ) {
        PreLaunchDecision::Skip => Ok(SyncAction::NoOp),
        PreLaunchDecision::Conflict => {
            let rollback = rollback_path(&context.game_id);
            transport.download_snapshot(&remote, &rollback)?;
            warn!(
                "Cloud save conflict for {}: archived remote snapshot to {:?}",
                context.game_id, rollback
            );
            Ok(SyncAction::ConflictArchived)
        }
        PreLaunchDecision::Pull => {
            let staged = cache.with_extension("remote.tar.zst");
            transport.download_snapshot(&remote, &staged)?;

            let actual = sha256_file(&staged)?;
            if !actual.eq_ignore_ascii_case(&remote.checksum) {
                return Err(BackupError::ChecksumMismatch {
                    expected: remote.checksum.clone(),
                    actual,
                });
            }

            if let Some(parent) = cache.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&staged, &cache)?;
            let _ = fs::remove_file(&staged);

            if let Some(client) = LudusaviClient::discover() {
                let staging = DATA_ROOT_DIR
                    .join("saves")
                    .join("staging")
                    .join(&context.game_id);
                if staging.exists() {
                    let _ = fs::remove_dir_all(&staging);
                }
                fs::create_dir_all(&staging)?;
                unpack_save_archive(&cache, &staging, Some(&remote.checksum))?;
                client.restore_game(
                    &context.game_title,
                    &staging,
                    context.wine_prefix.as_deref(),
                )?;
            }

            write_state(
                &context.game_id,
                &LocalSyncState {
                    last_uploaded_checksum: Some(remote.checksum.clone()),
                },
            )?;
            info!("Pulled cloud save snapshot for {}", context.game_id);
            Ok(SyncAction::Pulled)
        }
    }
}

/// Post-exit sync: run Ludusavi discovery, pack the archive, and upload it.
pub fn sync_post_exit_with(
    transport: &dyn CloudSaveTransport,
    context: &CloudSaveSyncContext,
    slot: u32,
) -> Result<SyncAction, BackupError> {
    let Some((_bytes, checksum)) = backup_saves_to_cache(context)? else {
        return Ok(SyncAction::NoOp);
    };

    let archive = cache_archive_path(&context.game_id);
    transport.upload_snapshot(&context.game_id, slot, &archive, &checksum)?;
    write_state(
        &context.game_id,
        &LocalSyncState {
            last_uploaded_checksum: Some(checksum.clone()),
        },
    )?;
    info!(
        "Uploaded cloud save snapshot for {} (sha256: {})",
        context.game_id, checksum
    );
    Ok(SyncAction::Pushed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_when_cache_matches_remote() {
        assert_eq!(
            decide_pre_launch("abc", Some("abc"), Some("abc")),
            PreLaunchDecision::Skip
        );
    }

    #[test]
    fn pull_when_remote_newer_and_local_clean() {
        assert_eq!(
            decide_pre_launch("remote", Some("cache"), Some("cache")),
            PreLaunchDecision::Pull
        );
    }

    #[test]
    fn conflict_when_local_has_unsynced_changes() {
        assert_eq!(
            decide_pre_launch("remote", Some("local-dirty"), Some("last-upload")),
            PreLaunchDecision::Conflict
        );
    }

    #[test]
    fn conflict_when_local_cache_exists_without_upload_history() {
        assert_eq!(
            decide_pre_launch("remote", Some("local"), None),
            PreLaunchDecision::Conflict
        );
    }

    #[test]
    fn pull_when_there_is_no_local_cache() {
        assert_eq!(
            decide_pre_launch("remote", None, None),
            PreLaunchDecision::Pull
        );
    }
}
