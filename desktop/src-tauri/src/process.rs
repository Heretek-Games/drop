use std::sync::Arc;

use process::{
    PROCESS_MANAGER,
    error::ProcessError,
    process_manager::{LaunchOption, LaunchOverrides, ProcessHandlerOption, ProcessManager},
};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn get_launch_options(id: String) -> Result<Vec<LaunchOption>, ProcessError> {
    let launch_options = ProcessManager::get_launch_options(id)?;

    Ok(launch_options)
}

#[tauri::command]
pub fn get_process_handlers(id: String) -> Result<Vec<ProcessHandlerOption>, ProcessError> {
    PROCESS_MANAGER.lock().get_process_handlers(id)
}

#[derive(Serialize)]
#[serde(tag = "result", content = "data")]
pub enum LaunchResult {
    Success,
    InstallRequired(String, String),
}

#[tauri::command]
pub fn launch_game(
    id: String,
    index: usize,
    overrides: Option<LaunchOverrides>,
) -> Result<LaunchResult, ProcessError> {
    let result = {
        let mut process_manager_lock = PROCESS_MANAGER.lock();

        process_manager_lock.launch_process(id, index, overrides)
    };

    if let Err(err) = &result
        && let ProcessError::RequiredDependency(game_id, version_id) = err
    {
        return Ok(LaunchResult::InstallRequired(
            game_id.to_string(),
            version_id.to_string(),
        ));
    }

    result?;

    Ok(LaunchResult::Success)
}

#[tauri::command]
pub fn kill_game(game_id: String) -> Result<(), ProcessError> {
    Ok(PROCESS_MANAGER.lock().kill_game(game_id)?)
}

#[tauri::command]
pub fn open_process_logs(game_id: String, app_handle: AppHandle) -> Result<(), ProcessError> {
    let process_manager_lock = PROCESS_MANAGER.lock();

    let dir = process_manager_lock.get_log_dir(game_id);
    app_handle
        .opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|v| ProcessError::OpenerError(Arc::new(v)))
}

/// Validate that a game has a native pipeline recipe, then run it in the
/// background. Returns an error synchronously (before any work starts) when the
/// version has no recipe, so the caller can fall back to the legacy setup.
#[tauri::command]
pub fn start_pipeline_setup(game_id: String, app_handle: AppHandle) -> Result<(), String> {
    if ::process::pipeline::pipeline_is_running(&game_id) {
        return Err(format!("A pipeline is already running for game {game_id}"));
    }
    let prepared = ::process::pipeline::prepare_pipeline(&game_id)?;

    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            ::process::pipeline::run_prepared_pipeline(app_handle, game_id.clone(), prepared).await
        {
            log::error!("pipeline setup failed for {game_id}: {e}");
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_pipeline_setup(game_id: String) -> bool {
    ::process::pipeline::cancel_pipeline(&game_id)
}

#[tauri::command]
pub fn reclaim_pipeline_space(game_id: String) -> Result<u64, String> {
    ::process::pipeline::reclaim_pipeline_space_for_game(&game_id)
}

#[tauri::command]
pub fn scan_installed_dir(game_id: String) -> Result<Vec<String>, String> {
    ::process::pipeline::scan_installed_dir(&game_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLaunchTarget {
    pub adopted: Option<String>,
    pub candidates: Vec<Candidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identified: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    path: String,
    score: f64,
    #[serde(default)]
    is_primary: bool,
}

const AUTO_ADOPT_SCORE: f64 = 50.0;

#[derive(Deserialize)]
struct ScanInstallResponse {
    candidates: Vec<Candidate>,
}

/// SHA-256 hashes a candidate executable and asks the GameBox plugin for a
/// known identity; returns the full fingerprint record when matched.
async fn gamebox_identify(exe_path: &std::path::Path) -> Option<serde_json::Value> {
    use sha2::Digest;
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(exe_path).await.ok()?;
    let mut hasher = sha2::Sha256::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let read = file.read(&mut buffer).await.ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let hash = hex::encode(hasher.finalize());

    let url =
        remote::requests::generate_url(&["/api/v1/plugins/drop-gamebox/identify"], &[]).ok()?;
    let response = remote::utils::DROP_CLIENT_ASYNC
        .post(url)
        .header(
            "Authorization",
            remote::auth::generate_authorization_header(),
        )
        .json(&serde_json::json!({ "hash": hash }))
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }
    let parsed: serde_json::Value = response.json().await.ok()?;
    if parsed.get("matched").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    parsed.get("game").cloned()
}

/// Resolves the post-install launch target for an installer-based version.
/// `chosen` (from the user picker) is adopted as-is; otherwise the top scoring
/// candidate is adopted automatically when confident.
pub async fn resolve_launch_target_impl(
    game_id: &str,
    chosen: Option<String>,
) -> Result<ResolvedLaunchTarget, String> {
    let (meta_id, version_id, platform, files, install_dir_path) = {
        use database::{GameDownloadStatus, borrow_db_checked};

        let db_lock = borrow_db_checked();
        let meta = db_lock
            .applications
            .installed_game_version
            .get(game_id)
            .cloned()
            .ok_or("Game is not installed")?;
        let status = db_lock
            .applications
            .game_statuses
            .get(game_id)
            .ok_or("Game status not found")?;
        let install_dir_path = match status {
            GameDownloadStatus::Installed { install_dir, .. } => install_dir.clone(),
            _ => return Err("Game is not in an installed/setup state".to_string()),
        };
        let files = ::process::pipeline::scan_installed_dir(game_id)?;
        (
            meta.id.clone(),
            meta.version.clone(),
            meta.target_platform,
            files,
            install_dir_path,
        )
    };

    if files.is_empty() {
        return Ok(ResolvedLaunchTarget {
            adopted: chosen.clone(),
            candidates: Vec::new(),
            identified: None,
        });
    }

    let body = match &chosen {
        Some(exe) => serde_json::json!({
            "gameId": meta_id,
            "versionId": version_id,
            "files": files,
            "adopt": {
                "name": "Play",
                "command": exe,
                "platform": platform,
            },
        }),
        None => serde_json::json!({
            "gameId": meta_id,
            "versionId": version_id,
            "files": files,
        }),
    };

    let adopt_url = remote::requests::generate_url(&["/api/v1/admin/library/scan-install"], &[])
        .map_err(|e| e.to_string())?;

    let response = remote::utils::DROP_CLIENT_ASYNC
        .post(adopt_url)
        .header(
            "Authorization",
            remote::auth::generate_authorization_header(),
        )
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("scan-install failed ({status}): {text}"));
    }

    let parsed: ScanInstallResponse = response.json().await.map_err(|e| e.to_string())?;

    let mut adopted: Option<String> = None;
    if chosen.is_none() {
        if let Some(top) = parsed.candidates.first() {
            let top_score = top.score;
            if top_score >= AUTO_ADOPT_SCORE {
                return Box::pin(resolve_launch_target_impl(game_id, Some(top.path.clone()))).await;
            }
        }
    } else {
        adopted = chosen.clone();
    }

    if let Some(_) = adopted
        && let Err(e) = refresh_version_launches(&meta_id, &version_id).await
    {
        log::warn!("launch target adopted but version refresh failed: {e}");
    }

    let identified = match &adopted {
        Some(relative) => {
            let exe_path = std::path::Path::new(&install_dir_path).join(relative);
            gamebox_identify(&exe_path).await
        }
        None => None,
    };

    Ok(ResolvedLaunchTarget {
        adopted,
        candidates: parsed.candidates,
        identified,
    })
}

/// Re-fetches the version's launch configurations from the Drop server so a
/// freshly adopted launch target is immediately usable.
async fn refresh_version_launches(game_id: &str, version_id: &str) -> Result<(), String> {
    let url = remote::requests::generate_url(
        &["/api/v1/client/game", game_id, "version", version_id],
        &[],
    )
    .map_err(|e| e.to_string())?;

    let response = remote::utils::DROP_CLIENT_ASYNC
        .get(url)
        .header(
            "Authorization",
            remote::auth::generate_authorization_header(),
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "version manifest fetch failed ({})",
            response.status()
        ));
    }

    let mut version: database::GameVersion = response.json().await.map_err(|e| e.to_string())?;

    let mut db = database::borrow_db_mut_checked();
    if let Some(existing) = db.applications.game_versions.get(version_id) {
        version.user_configuration = existing.user_configuration.clone();
    }
    db.applications
        .game_versions
        .insert(version_id.to_string(), version);
    Ok(())
}

/// Resolves the post-install launch target for an installer-based version.
#[tauri::command]
pub async fn resolve_launch_target(
    game_id: String,
    chosen: Option<String>,
) -> Result<ResolvedLaunchTarget, String> {
    resolve_launch_target_impl(&game_id, chosen).await
}
