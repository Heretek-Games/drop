use std::path::Path;

use cloud_saves::error::BackupError;
use cloud_saves::transport::{CloudSaveTransport, RemoteSaveSnapshot, parse_latest_snapshot};
use remote::auth::generate_authorization_header;
use remote::requests::generate_url;
use remote::utils::DROP_CLIENT_SYNC;

fn to_error<E: std::fmt::Display>(error: E) -> BackupError {
    BackupError::ExecutionError(error.to_string())
}

/// Authenticated Drop-server transport for the cloud save sync engine.
pub struct DropServerTransport;

impl CloudSaveTransport for DropServerTransport {
    fn fetch_latest_snapshot(
        &self,
        game_id: &str,
        slot: u32,
    ) -> Result<Option<RemoteSaveSnapshot>, BackupError> {
        let url = generate_url(&["/api/v1/client/saves", game_id, &slot.to_string()], &[])
            .map_err(to_error)?;

        let response = DROP_CLIENT_SYNC
            .get(url)
            .header("Authorization", generate_authorization_header())
            .send()
            .map_err(to_error)?;

        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(BackupError::ExecutionError(format!(
                "cloud save metadata request failed: {}",
                response.status()
            )));
        }

        let body = response.text().map_err(to_error)?;
        parse_latest_snapshot(&body)
    }

    fn download_snapshot(
        &self,
        snapshot: &RemoteSaveSnapshot,
        dest: &Path,
    ) -> Result<(), BackupError> {
        let url =
            generate_url(&["/api/v1/client/object", &snapshot.object_id], &[]).map_err(to_error)?;

        let response = DROP_CLIENT_SYNC
            .get(url)
            .header("Authorization", generate_authorization_header())
            .send()
            .map_err(to_error)?;

        if !response.status().is_success() {
            return Err(BackupError::ExecutionError(format!(
                "cloud save download failed: {}",
                response.status()
            )));
        }

        let bytes = response.bytes().map_err(to_error)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(dest, bytes)?;
        Ok(())
    }

    fn upload_snapshot(
        &self,
        game_id: &str,
        slot: u32,
        archive: &Path,
        _checksum: &str,
    ) -> Result<(), BackupError> {
        let url = generate_url(
            &["/api/v1/client/saves", game_id, &slot.to_string(), "push"],
            &[],
        )
        .map_err(to_error)?;

        let file = std::fs::File::open(archive)?;
        let response = DROP_CLIENT_SYNC
            .post(url)
            .header("Authorization", generate_authorization_header())
            .body(file)
            .send()
            .map_err(to_error)?;

        if !response.status().is_success() {
            return Err(BackupError::ExecutionError(format!(
                "cloud save upload failed: {}",
                response.status()
            )));
        }
        Ok(())
    }
}
