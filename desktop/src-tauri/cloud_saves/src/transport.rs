use std::path::Path;

use crate::error::BackupError;

/// A single remote cloud-save snapshot: the storage object id and the SHA-256
/// of its plaintext archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSaveSnapshot {
    pub object_id: String,
    pub checksum: String,
}

/// Transport used by the sync engine to reach the Drop server. Kept as a trait
/// so the orchestration can be unit-tested without a network and so the desktop
/// layer owns the authenticated HTTP implementation.
pub trait CloudSaveTransport: Send + Sync {
    /// Latest snapshot for `(game_id, slot)`, or `None` when no save exists.
    fn fetch_latest_snapshot(
        &self,
        game_id: &str,
        slot: u32,
    ) -> Result<Option<RemoteSaveSnapshot>, BackupError>;

    /// Download a snapshot's archive bytes into `dest`.
    fn download_snapshot(
        &self,
        snapshot: &RemoteSaveSnapshot,
        dest: &Path,
    ) -> Result<(), BackupError>;

    /// Upload `archive` for `(game_id, slot)`, expected to hash to `checksum`.
    fn upload_snapshot(
        &self,
        game_id: &str,
        slot: u32,
        archive: &Path,
        checksum: &str,
    ) -> Result<(), BackupError>;
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSlotResponse {
    #[serde(default)]
    history_object_ids: Vec<String>,
    #[serde(default)]
    history_checksums: Vec<String>,
}

/// Parses the JSON body of `GET /api/v1/client/saves/:gameid/:slotindex` and
/// returns its newest snapshot, if any.
pub fn parse_latest_snapshot(json: &str) -> Result<Option<RemoteSaveSnapshot>, BackupError> {
    let slot: SaveSlotResponse = serde_json::from_str(json)?;
    match (
        slot.history_object_ids.last(),
        slot.history_checksums.last(),
    ) {
        (Some(object_id), Some(checksum)) => Ok(Some(RemoteSaveSnapshot {
            object_id: object_id.clone(),
            checksum: checksum.clone(),
        })),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_newest_snapshot() {
        let json = r#"{
            "index": 1,
            "historyObjectIds": ["obj-old", "obj-new"],
            "historyChecksums": ["hash-old", "hash-new"]
        }"#;
        let snapshot = parse_latest_snapshot(json).unwrap().unwrap();
        assert_eq!(snapshot.object_id, "obj-new");
        assert_eq!(snapshot.checksum, "hash-new");
    }

    #[test]
    fn empty_history_yields_no_snapshot() {
        let json = r#"{ "index": 1, "historyObjectIds": [], "historyChecksums": [] }"#;
        assert!(parse_latest_snapshot(json).unwrap().is_none());
    }

    #[test]
    fn malformed_json_is_a_serialization_error() {
        let err = parse_latest_snapshot("not json").unwrap_err();
        assert!(matches!(err, BackupError::SerializationError(_)));
    }
}
