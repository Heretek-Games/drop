use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::anyhow;
use droplet_rs::{
    manifest::Manifest,
    versions::{create_backend_constructor, types::VersionBackend},
};
use log::warn;
use reqwest::StatusCode;
use serde_json::Value;

use crate::{
    conversions::convert_protobuf_manifest,
    proto::version::{VersionResponse, version_response::library_source::LibraryBackend},
    server::download::fetch_version_data,
    state::AppState,
    util::ErrorOption,
};

pub struct DownloadContext {
    pub(crate) manifest: Manifest,
    pub(crate) backend: Arc<dyn VersionBackend + Send + Sync + 'static>,
    last_access: Mutex<Instant>,
}

impl DownloadContext {
    #[must_use]
    pub fn last_access(&self) -> Instant {
        *self
            .last_access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn reset_last_access(&self) {
        *self
            .last_access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Instant::now();
    }
}

/// Fetches a version from the Drop server and builds the depot download context
/// (manifest + storage backend) for it.
///
/// # Errors
///
/// Returns an error when the server query fails, the returned manifest cannot be
/// converted, or the version's storage backend cannot be constructed.
pub async fn create_download_context(
    app_state: &AppState,
    game_id: String,
    version_name: String,
) -> Result<DownloadContext, ErrorOption> {
    let version_data = fetch_version_data(app_state, game_id, version_name.clone()).await?;

    let backend = create_backend(&version_data)?;

    let manifest = version_data
        .manifest
        .into_option()
        .ok_or_else(|| anyhow!("version {version_name} has no manifest"))?;

    let download_context = DownloadContext {
        manifest: convert_protobuf_manifest(manifest)?,
        backend,
        last_access: Mutex::new(Instant::now()),
    };

    Ok(download_context)
}

fn create_backend(
    version_data: &VersionResponse,
) -> Result<Arc<dyn VersionBackend + Send + Sync>, StatusCode> {
    let options = serde_json::from_str::<Value>(&version_data.source.options)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let base_path = options
        .get("baseDir")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            warn!("library source options are missing a string 'baseDir'");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let version_path = PathBuf::from(base_path);
    let version_path = version_path.join(version_data.library_path.clone());
    let backend_kind = version_data
        .source
        .backend
        .enum_value()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let version_path = match backend_kind {
        LibraryBackend::FILESYSTEM => version_path.join(version_data.version_path.clone()),
        LibraryBackend::FLAT_FILESYSTEM => version_path,
    };

    if !version_path.exists() {
        warn!("{} path doesn't exist for version", version_path.display());
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let backend_constructor =
        create_backend_constructor(&version_path).ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let backend = backend_constructor()
        .inspect_err(|err| warn!("failed to create version backend: {err:?}"))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Arc::from(backend))
}
