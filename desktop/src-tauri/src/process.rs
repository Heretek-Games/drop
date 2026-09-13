use std::sync::Arc;

use process::{
    PROCESS_MANAGER,
    error::ProcessError,
    process_manager::{LaunchOption, ProcessHandlerOption, ProcessManager},
};
use serde::Serialize;
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
pub fn launch_game(id: String, index: usize) -> Result<LaunchResult, ProcessError> {
    let result = {
        let mut process_manager_lock = PROCESS_MANAGER.lock();

        process_manager_lock.launch_process(id, index)
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
