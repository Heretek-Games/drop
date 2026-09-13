use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
        nonpoison::Mutex,
    },
};

use database::{
    DownloadableMetadata, GameDownloadStatus, borrow_db_checked, borrow_db_mut_checked,
    db::DATA_ROOT_DIR, models::data::InstalledGameType, platform::Platform,
};
use games::{library::push_game_update, state::GameStatusManager};
use log::{debug, error, info, warn};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter as _};
use tokio::io::{AsyncBufReadExt, BufReader};

pub static RUNNING_PIPELINES: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum DistributionType {
    SceneRelease,
    GogInstaller,
    FitGirlRepack,
    KaOsRepack,
    DodiRepack,
    ArchiveBundle,
    LoosePortable,
    PatchUpdate,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PipelineStepAction {
    ExtractRar,
    ExtractIso,
    ExtractArchive,
    Innoextract,
    ApplyCrack,
    Cleanup,
    RunCommand,
    #[serde(other)]
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStep {
    pub id: String,
    pub action: PipelineStepAction,
    #[serde(default)]
    pub params: HashMap<String, serde_json::Value>,
    pub description: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRecipe {
    #[serde(default = "default_recipe_version")]
    pub version: String,
    pub distribution_type: DistributionType,
    pub release_group: Option<String>,
    #[serde(default)]
    pub steps: Vec<PipelineStep>,
    pub target_executable: String,
    #[serde(default)]
    pub target_args: Vec<String>,
    pub setup_command: Option<String>,
    pub setup_script_windows: Option<String>,
    pub setup_script_linux: Option<String>,
}

fn default_recipe_version() -> String {
    "1".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressEvent {
    pub game_id: String,
    pub step_index: usize,
    pub total_steps: usize,
    pub step_id: String,
    pub action: String,
    pub description: String,
    pub percentage: u8,
    pub current_file: Option<String>,
    pub log_line: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompletedEvent {
    pub game_id: String,
    pub success: bool,
    pub reclaimable_bytes: u64,
    pub error: Option<String>,
}

pub fn parse_7z_progress(line: &str) -> Option<u8> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d{1,3})%").unwrap());
    RE.captures(line).and_then(|cap| {
        cap.get(1)
            .and_then(|m| m.as_str().parse::<u8>().ok())
            .filter(|&pct| pct <= 100)
    })
}

pub fn parse_innoextract_progress(line: &str) -> Option<u8> {
    static RE_INNO: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[\s*(\d{1,3})%\]|(\d{1,3})%").unwrap());
    RE_INNO.captures(line).and_then(|cap| {
        let matched = cap.get(1).or_else(|| cap.get(2))?;
        matched
            .as_str()
            .parse::<u8>()
            .ok()
            .filter(|&pct| pct <= 100)
    })
}

pub fn find_tool_binary(tool_name: &str) -> Option<PathBuf> {
    // 1. Check portable bundled directory inside DATA_ROOT_DIR
    let portable = DATA_ROOT_DIR.join("tools").join(tool_name);
    #[cfg(target_os = "windows")]
    let portable_bin = portable.join(format!("{}.exe", tool_name));
    #[cfg(not(target_os = "windows"))]
    let portable_bin = portable.join(tool_name);

    if portable_bin.is_file() {
        return Some(portable_bin);
    }

    // 2. Standard installation paths on Windows
    #[cfg(target_os = "windows")]
    {
        if tool_name == "7z" {
            let win_candidates = [
                PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
                PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
            ];
            for candidate in win_candidates {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    // 3. Search in system PATH
    let path_var = std::env::var_os("PATH")?;
    for p in std::env::split_paths(&path_var) {
        #[cfg(target_os = "windows")]
        let candidate = p.join(format!("{}.exe", tool_name));
        #[cfg(not(target_os = "windows"))]
        let candidate = p.join(tool_name);

        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 4. Try common aliases (e.g. 7za on linux)
    if tool_name == "7z" {
        return find_tool_binary("7za");
    }

    None
}

pub fn cancel_pipeline(game_id: &str) -> bool {
    let lock = RUNNING_PIPELINES.lock();
    if let Some(flag) = lock.get(game_id) {
        flag.store(true, Ordering::SeqCst);
        info!(
            "Cancellation requested for game pipeline setup: {}",
            game_id
        );
        true
    } else {
        false
    }
}

/// Data required to run a pipeline, resolved from the local database.
pub struct PreparedPipeline {
    pub recipe: PipelineRecipe,
    pub install_dir: PathBuf,
    pub meta: DownloadableMetadata,
}

/// Load the pipeline recipe and install directory for a game from the local
/// database. This is synchronous so IPC commands can validate availability
/// before spawning the async runner, falling back to the legacy setup command
/// when a version predates the recipe engine.
pub fn prepare_pipeline(game_id: &str) -> Result<PreparedPipeline, String> {
    let db_lock = borrow_db_checked();

    let meta = db_lock
        .applications
        .installed_game_version
        .get(game_id)
        .cloned()
        .ok_or_else(|| "Game is not installed".to_string())?;

    let status = db_lock
        .applications
        .game_statuses
        .get(game_id)
        .ok_or_else(|| "Game status not found".to_string())?;

    let install_dir = match status {
        GameDownloadStatus::Installed { install_dir, .. } => PathBuf::from(install_dir),
        _ => return Err("Game is not in an installed/setup state".to_string()),
    };

    let version = db_lock
        .applications
        .game_versions
        .get(&meta.version)
        .ok_or_else(|| "Game version not found".to_string())?;

    let manifest = version
        .droplet_manifest
        .as_ref()
        .ok_or_else(|| "This version has no droplet manifest; use legacy setup".to_string())?;

    let recipe_value = manifest
        .get("recipe")
        .ok_or_else(|| "This version has no pipeline recipe; use legacy setup".to_string())?;

    let recipe: PipelineRecipe = serde_json::from_value(recipe_value.clone())
        .map_err(|e| format!("Failed to parse pipeline recipe: {e}"))?;

    Ok(PreparedPipeline {
        recipe,
        install_dir,
        meta,
    })
}

pub async fn run_pipeline_for_game(app_handle: AppHandle, game_id: String) -> Result<u64, String> {
    let prepared = prepare_pipeline(&game_id)?;
    run_prepared_pipeline(app_handle, game_id, prepared).await
}

/// Names written as setup scripts must stay inside the install directory.
fn safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\'])
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Writes the recipe's generated fallback setup script into `install_dir`.
///
/// The native pipeline is the primary setup path; this keeps the legacy
/// `setups` fallback runnable when the client cannot execute the recipe.
pub fn materialize_setup_script(
    manifest: &serde_json::Value,
    install_dir: &Path,
    platform: &Platform,
) -> Result<Option<String>, String> {
    let Some(recipe_value) = manifest.get("recipe") else {
        return Ok(None);
    };
    let recipe: PipelineRecipe = serde_json::from_value(recipe_value.clone())
        .map_err(|e| format!("Failed to parse pipeline recipe: {e}"))?;

    let (script, default_name) = match platform {
        Platform::Windows => (recipe.setup_script_windows, "drop-pipeline-setup.bat"),
        _ => (recipe.setup_script_linux, "drop-pipeline-setup.sh"),
    };
    let Some(script) = script else {
        return Ok(None);
    };

    let name = recipe
        .setup_command
        .unwrap_or_else(|| default_name.to_string());
    if !safe_script_name(&name) {
        return Err("refusing to write an unsafe setup script name".to_string());
    }

    let path = install_dir.join(&name);
    fs::write(&path, script).map_err(|e| format!("failed to write {name}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&path, fs::Permissions::from_mode(0o755)) {
            warn!("failed to mark {name} executable: {e}");
        }
    }
    Ok(Some(name))
}

pub async fn run_prepared_pipeline(
    app_handle: AppHandle,
    game_id: String,
    prepared: PreparedPipeline,
) -> Result<u64, String> {
    let PreparedPipeline {
        recipe,
        install_dir,
        meta,
    } = prepared;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    RUNNING_PIPELINES
        .lock()
        .insert(game_id.clone(), cancel_flag.clone());

    let result = execute_pipeline(
        &app_handle,
        &game_id,
        &install_dir,
        &recipe,
        cancel_flag.clone(),
    )
    .await;

    RUNNING_PIPELINES.lock().remove(&game_id);

    match result {
        Ok(reclaimable_bytes) => {
            info!(
                "Pipeline setup completed successfully for game {}. Reclaimable bytes: {}",
                game_id, reclaimable_bytes
            );

            // Transition status to Installed
            {
                let mut db_mut = borrow_db_mut_checked();
                if let Some(GameDownloadStatus::Installed { install_type, .. }) =
                    db_mut.applications.game_statuses.get_mut(&game_id)
                {
                    *install_type = InstalledGameType::Installed;
                }
                db_mut.applications.transient_statuses.remove(&meta);

                let version_data = db_mut
                    .applications
                    .game_versions
                    .get(&meta.version)
                    .cloned();
                let status = GameStatusManager::fetch_state(&game_id, &db_mut);

                push_game_update(&app_handle, &game_id, version_data, status);
            }

            let _ = app_handle.emit(
                "pipeline_completed",
                PipelineCompletedEvent {
                    game_id: game_id.clone(),
                    success: true,
                    reclaimable_bytes,
                    error: None,
                },
            );

            Ok(reclaimable_bytes)
        }
        Err(err) => {
            error!("Pipeline setup failed for game {}: {}", game_id, err);

            let _ = app_handle.emit(
                "pipeline_completed",
                PipelineCompletedEvent {
                    game_id: game_id.clone(),
                    success: false,
                    reclaimable_bytes: 0,
                    error: Some(err.clone()),
                },
            );

            Err(err)
        }
    }
}

/// Reclaim intermediate archives for a game and return the number of bytes freed.
pub fn reclaim_pipeline_space_for_game(game_id: &str) -> Result<u64, String> {
    let prepared = prepare_pipeline(game_id)?;
    reclaim_pipeline_space(&prepared.recipe, &prepared.install_dir).map_err(|e| e.to_string())
}

async fn execute_pipeline(
    app_handle: &AppHandle,
    game_id: &str,
    install_dir: &Path,
    recipe: &PipelineRecipe,
    cancel_flag: Arc<AtomicBool>,
) -> Result<u64, String> {
    let total_steps = recipe.steps.len();

    info!(
        "Starting pipeline execution for game {} with {} steps",
        game_id, total_steps
    );

    for (step_index, step) in recipe.steps.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err("Pipeline setup cancelled by user".to_string());
        }

        info!(
            "Step {}/{}: {} ({:?})",
            step_index + 1,
            total_steps,
            step.description,
            step.action
        );

        emit_progress(
            app_handle,
            game_id,
            step_index,
            total_steps,
            &step.id,
            &step.action,
            &step.description,
            0,
            None,
            Some(format!("Starting: {}", step.description)),
        );

        let step_res = match step.action {
            PipelineStepAction::ExtractRar => {
                execute_extract_rar(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    step,
                    install_dir,
                    cancel_flag.clone(),
                )
                .await
            }
            PipelineStepAction::ExtractIso => {
                execute_extract_iso(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    step,
                    install_dir,
                    cancel_flag.clone(),
                )
                .await
            }
            PipelineStepAction::ExtractArchive => {
                execute_extract_archive(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    step,
                    install_dir,
                    cancel_flag.clone(),
                )
                .await
            }
            PipelineStepAction::Innoextract => {
                execute_innoextract(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    step,
                    install_dir,
                    cancel_flag.clone(),
                )
                .await
            }
            PipelineStepAction::ApplyCrack => {
                execute_apply_crack(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    step,
                    install_dir,
                )
                .await
            }
            PipelineStepAction::Cleanup => {
                // Post-setup cleanup is typically deferred until user confirms,
                // but any explicit non-optional intermediate cleanup step can run here
                if !step.optional {
                    execute_cleanup_step(step, install_dir).await
                } else {
                    Ok(())
                }
            }
            PipelineStepAction::RunCommand => execute_run_command(step, install_dir).await,
            PipelineStepAction::Unknown => {
                warn!("Skipping unknown step action: {:?}", step.action);
                Ok(())
            }
        };

        if let Err(err) = step_res {
            if step.optional {
                warn!("Optional step {} failed, continuing: {}", step.id, err);
            } else {
                return Err(format!("Step '{}' failed: {}", step.id, err));
            }
        }

        emit_progress(
            app_handle,
            game_id,
            step_index,
            total_steps,
            &step.id,
            &step.action,
            &step.description,
            100,
            None,
            Some(format!("Completed: {}", step.description)),
        );
    }

    // Clean up temporary extraction directories like .drop_iso_tmp
    let tmp_iso_dir = install_dir.join(".drop_iso_tmp");
    if tmp_iso_dir.is_dir() {
        let _ = fs::remove_dir_all(&tmp_iso_dir);
    }

    let reclaimable = calculate_reclaimable_space(recipe, install_dir);
    Ok(reclaimable)
}

fn emit_progress(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step_id: &str,
    action: &PipelineStepAction,
    description: &str,
    percentage: u8,
    current_file: Option<String>,
    log_line: Option<String>,
) {
    let action_str = format!("{:?}", action);
    let _ = app_handle.emit(
        "pipeline_progress",
        PipelineProgressEvent {
            game_id: game_id.to_string(),
            step_index,
            total_steps,
            step_id: step_id.to_string(),
            action: action_str,
            description: description.to_string(),
            percentage,
            current_file,
            log_line,
        },
    );
}

async fn execute_extract_rar(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let tool = find_tool_binary("7z").ok_or_else(|| tool_missing_error("7z"))?;

    // Server recipes use `input`; older recipes may use `archive`.
    let archive_name = step
        .params
        .get("input")
        .or_else(|| step.params.get("archive"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty());

    let archive_path = match archive_name {
        Some(name) if !name.contains(['*', '?']) => install_dir.join(name),
        _ => find_primary_rar(install_dir)
            .ok_or_else(|| "No primary RAR archive found in game directory".to_string())?,
    };

    if !archive_path.is_file() {
        return Err(format!(
            "Archive file not found: {}",
            archive_path.display()
        ));
    }

    let output_sub = step
        .params
        .get("outputDir")
        .and_then(|v| v.as_str())
        .unwrap_or(".drop_iso_tmp");

    let output_dir = install_dir.join(output_sub);
    fs::create_dir_all(&output_dir).map_err(|e| {
        format!(
            "Failed to create output directory {}: {}",
            output_dir.display(),
            e
        )
    })?;

    let mut cmd = tokio::process::Command::new(tool);
    cmd.arg("x")
        .arg("-y")
        .arg("-bsp1")
        .arg(&archive_path)
        .arg(format!("-o{}", output_dir.display()))
        .current_dir(install_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    run_process_with_progress(
        cmd,
        app_handle,
        game_id,
        step_index,
        total_steps,
        step,
        cancel_flag,
        parse_7z_progress,
    )
    .await
}

async fn execute_extract_iso(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let tool = find_tool_binary("7z").ok_or_else(|| tool_missing_error("7z"))?;

    let output_sub = step
        .params
        .get("outputDir")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let output_dir = if output_sub == "." {
        install_dir.to_path_buf()
    } else {
        install_dir.join(output_sub)
    };
    fs::create_dir_all(&output_dir).map_err(|e| {
        format!(
            "Failed to create output directory {}: {}",
            output_dir.display(),
            e
        )
    })?;

    // Recipes provide `sourceGlob` (e.g. ".drop_iso_tmp/*.iso"); fall back to
    // the legacy `isoDir` param, then the temporary extraction directory.
    let source_glob = step
        .params
        .get("sourceGlob")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let scan_dirs: Vec<PathBuf> = {
        let mut dirs = Vec::new();
        if !source_glob.is_empty() {
            let rel = source_glob.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
            dirs.push(if rel == "." || rel.is_empty() {
                install_dir.to_path_buf()
            } else {
                install_dir.join(rel)
            });
        }
        let iso_dir_sub = step
            .params
            .get("isoDir")
            .and_then(|v| v.as_str())
            .unwrap_or(".drop_iso_tmp");
        dirs.push(install_dir.join(iso_dir_sub));
        dirs.push(install_dir.to_path_buf());
        dirs
    };

    let mut isos = Vec::new();
    for dir in scan_dirs {
        if !dir.is_dir() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file()
                    && p.extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("iso"))
                    && !isos.contains(&p)
                {
                    isos.push(p);
                }
            }
        }
    }

    if isos.is_empty() {
        return Err("No ISO disc image found to extract".to_string());
    }

    for iso_path in isos {
        info!("Extracting ISO: {}", iso_path.display());
        let mut cmd = tokio::process::Command::new(&tool);
        cmd.arg("x")
            .arg("-y")
            .arg("-bsp1")
            .arg(&iso_path)
            .arg(format!("-o{}", output_dir.display()))
            .current_dir(install_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        run_process_with_progress(
            cmd,
            app_handle,
            game_id,
            step_index,
            total_steps,
            step,
            cancel_flag.clone(),
            parse_7z_progress,
        )
        .await?;
    }

    Ok(())
}

async fn execute_extract_archive(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let tool = find_tool_binary("7z").ok_or_else(|| tool_missing_error("7z"))?;

    // Server recipes use `archiveFile`; older recipes may use `archive`.
    let archive_name = step
        .params
        .get("archiveFile")
        .or_else(|| step.params.get("archive"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "archiveFile parameter missing for extract_archive step".to_string())?;

    let output_sub = step
        .params
        .get("outputDir")
        .and_then(|v| v.as_str())
        .unwrap_or(".");
    let output_dir = if output_sub == "." {
        install_dir.to_path_buf()
    } else {
        install_dir.join(output_sub)
    };

    let archive_path = install_dir.join(archive_name);
    let mut cmd = tokio::process::Command::new(tool);
    cmd.arg("x")
        .arg("-y")
        .arg("-bsp1")
        .arg(&archive_path)
        .arg(format!("-o{}", output_dir.display()))
        .current_dir(install_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    run_process_with_progress(
        cmd,
        app_handle,
        game_id,
        step_index,
        total_steps,
        step,
        cancel_flag,
        parse_7z_progress,
    )
    .await
}

async fn execute_innoextract(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let tool = find_tool_binary("innoextract").ok_or_else(|| tool_missing_error("innoextract"))?;

    let setup_exe = step
        .params
        .get("installerExe")
        .and_then(|v| v.as_str())
        .unwrap_or("setup.exe");

    let output_sub = step
        .params
        .get("outputDir")
        .and_then(|v| v.as_str())
        .unwrap_or("app");

    let setup_path = install_dir.join(setup_exe);
    let mut cmd = tokio::process::Command::new(tool);
    cmd.arg("-e")
        .arg("-d")
        .arg(output_sub)
        .arg(&setup_path)
        .current_dir(install_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    run_process_with_progress(
        cmd,
        app_handle,
        game_id,
        step_index,
        total_steps,
        step,
        cancel_flag,
        parse_innoextract_progress,
    )
    .await
}

async fn execute_apply_crack(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
) -> Result<(), String> {
    let candidates = [
        "RUNE",
        "TENOKE",
        "CODEX",
        "FLT",
        "PLAZA",
        "SKIDROW",
        "DEViANCE",
        "RELOADED",
        "HOODLUM",
        "FAIRLIGHT",
        "EMPRESS",
        "PROPHET",
        "TiNYiSO",
        "ALiAS",
        "BAT",
        "Razor1911",
        "Crack",
    ];

    let mut crack_dirs = Vec::new();
    let specified_dir = step.params.get("crackDir").and_then(|v| v.as_str());

    if let Some(c) = specified_dir {
        let p = install_dir.join(c);
        if p.is_dir() {
            crack_dirs.push(p);
        }
        let p_tmp = install_dir.join(".drop_iso_tmp").join(c);
        if p_tmp.is_dir() {
            crack_dirs.push(p_tmp);
        }
    }

    // Also scan candidates in root and .drop_iso_tmp
    for c in candidates {
        let p = install_dir.join(c);
        if p.is_dir() && !crack_dirs.contains(&p) {
            crack_dirs.push(p);
        }
        let p_tmp = install_dir.join(".drop_iso_tmp").join(c);
        if p_tmp.is_dir() && !crack_dirs.contains(&p_tmp) {
            crack_dirs.push(p_tmp);
        }
    }

    if crack_dirs.is_empty() {
        info!("No crack directory found to apply. Skipping crack overlay.");
        return Ok(());
    }

    for crack_path in crack_dirs {
        info!("Applying crack overlay from: {}", crack_path.display());
        overlay_directory(&crack_path, install_dir)?;

        emit_progress(
            app_handle,
            game_id,
            step_index,
            total_steps,
            &step.id,
            &step.action,
            &step.description,
            100,
            None,
            Some(format!(
                "Applied crack overlay from {}",
                crack_path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            )),
        );
    }

    Ok(())
}

pub fn overlay_directory(src_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    for entry in walkdir::WalkDir::new(src_dir).min_depth(1) {
        let entry = entry.map_err(|e| format!("Walkdir error: {e}"))?;
        let rel_path = entry
            .path()
            .strip_prefix(src_dir)
            .map_err(|e| format!("Strip prefix error: {e}"))?;
        let target_path = dest_dir.join(rel_path);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target_path)
                .map_err(|e| format!("Failed to create dir {}: {}", target_path.display(), e))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!("Failed to create parent dir {}: {}", parent.display(), e)
                })?;
            }
            fs::copy(entry.path(), &target_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    entry.path().display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

async fn execute_cleanup_step(step: &PipelineStep, install_dir: &Path) -> Result<(), String> {
    if let Some(serde_json::Value::Array(targets)) = step.params.get("targets") {
        for t in targets {
            if let Some(pattern) = t.as_str() {
                // Targets without a wildcard may be directories (e.g. .drop_iso_tmp).
                if !pattern.contains(['*', '?', '[']) {
                    let dir = install_dir.join(pattern);
                    if dir.is_dir() {
                        if let Err(e) = fs::remove_dir_all(&dir) {
                            warn!(
                                "Failed to remove temporary directory {}: {}",
                                dir.display(),
                                e
                            );
                        }
                        continue;
                    }
                }
                delete_pattern(install_dir, pattern);
            }
        }
    }
    Ok(())
}

fn tool_missing_error(tool: &str) -> String {
    match tool {
        "7z" => "7-Zip (7z) was not found. Install 7-Zip or p7zip-full, or place a \
                 portable 7z binary in <drop data dir>/tools/7z/."
            .to_string(),
        "innoextract" => "innoextract was not found. Install innoextract to set up GOG/Inno \
                          Setup releases."
            .to_string(),
        other => format!("Required extraction tool '{other}' was not found on this system."),
    }
}

async fn execute_run_command(step: &PipelineStep, install_dir: &Path) -> Result<(), String> {
    let cmd_str = step
        .params
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "command parameter missing for run_command step".to_string())?;

    let parts = shell_words::split(cmd_str)
        .map_err(|e| format!("Failed to parse command arguments: {e}"))?;
    if parts.is_empty() {
        return Ok(());
    }

    let mut cmd = tokio::process::Command::new(&parts[0]);
    cmd.args(&parts[1..]).current_dir(install_dir);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute command '{}': {}", cmd_str, e))?;

    if !output.status.success() {
        return Err(format!(
            "Command exited with code {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

async fn run_process_with_progress<F>(
    mut cmd: tokio::process::Command,
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    cancel_flag: Arc<AtomicBool>,
    progress_parser: F,
) -> Result<(), String>
where
    F: Fn(&str) -> Option<u8> + Send + 'static,
{
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child.stderr.take();

    // Drain stderr on a separate task so a chatty tool can never fill the pipe
    // buffer and deadlock, while still collecting it for error reporting.
    let stderr_task = tokio::spawn(async move {
        let mut collected = Vec::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push(line);
            }
        }
        collected
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut last_percentage = 0u8;

    while let Some(line) = reader.next_line().await.map_err(|e| e.to_string())? {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = kill_process_tree(&mut child).await;
            stderr_task.abort();
            return Err("Operation cancelled by user".to_string());
        }

        if let Some(pct) = progress_parser(&line) {
            if pct != last_percentage {
                last_percentage = pct;
                emit_progress(
                    app_handle,
                    game_id,
                    step_index,
                    total_steps,
                    &step.id,
                    &step.action,
                    &step.description,
                    pct,
                    None,
                    Some(line.clone()),
                );
            }
        } else {
            debug!("[{}] {}", step.id, line);
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Process wait failed: {e}"))?;
    let stderr_lines = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let detail = if stderr_lines.is_empty() {
            String::new()
        } else {
            format!(": {}", stderr_lines.join("\n"))
        };
        return Err(format!(
            "Process exited with failure status {:?}{}",
            status.code(),
            detail
        ));
    }
    Ok(())
}

async fn kill_process_tree(child: &mut tokio::process::Child) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if let Some(pid) = child.id() {
            let killed = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", pid.to_string().as_str()])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if killed {
                return Ok(());
            }
        }
    }
    child.kill().await
}

pub fn calculate_reclaimable_space(recipe: &PipelineRecipe, install_dir: &Path) -> u64 {
    let mut total_bytes = 0u64;

    for step in &recipe.steps {
        if step.action == PipelineStepAction::Cleanup {
            if let Some(serde_json::Value::Array(targets)) = step.params.get("targets") {
                for t in targets {
                    if let Some(pat) = t.as_str() {
                        total_bytes += calculate_pattern_size(install_dir, pat);
                    }
                }
            }
        }
    }

    // Default heuristics if no cleanup targets were defined
    if total_bytes == 0 {
        total_bytes += calculate_pattern_size(install_dir, "*.rar");
        total_bytes += calculate_pattern_size(install_dir, "*.r[0-9][0-9]");
        total_bytes += calculate_pattern_size(install_dir, "*.iso");
    }

    total_bytes
}

pub fn reclaim_pipeline_space(
    recipe: &PipelineRecipe,
    install_dir: &Path,
) -> Result<u64, io::Error> {
    let mut total_deleted = 0u64;

    for step in &recipe.steps {
        if step.action == PipelineStepAction::Cleanup {
            if let Some(serde_json::Value::Array(targets)) = step.params.get("targets") {
                for t in targets {
                    if let Some(pat) = t.as_str() {
                        total_deleted += delete_pattern(install_dir, pat);
                    }
                }
            }
        }
    }

    if total_deleted == 0 {
        total_deleted += delete_pattern(install_dir, "*.rar");
        total_deleted += delete_pattern(install_dir, "*.r[0-9][0-9]");
        total_deleted += delete_pattern(install_dir, "*.iso");
    }

    // Remove any leftover temporary folders
    let tmp_iso = install_dir.join(".drop_iso_tmp");
    if tmp_iso.is_dir() {
        let _ = fs::remove_dir_all(&tmp_iso);
    }

    Ok(total_deleted)
}

fn calculate_pattern_size(base_dir: &Path, pattern: &str) -> u64 {
    let mut size = 0u64;
    let Ok(entries) = fs::read_dir(base_dir) else {
        return 0;
    };

    let regex_pattern = glob_to_regex(pattern);
    let Ok(re) = Regex::new(&regex_pattern) else {
        return 0;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if re.is_match(&name) {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    size += meta.len();
                }
            }
        }
    }
    size
}

fn delete_pattern(base_dir: &Path, pattern: &str) -> u64 {
    let mut deleted = 0u64;
    let Ok(entries) = fs::read_dir(base_dir) else {
        return 0;
    };

    let regex_pattern = glob_to_regex(pattern);
    let Ok(re) = Regex::new(&regex_pattern) else {
        return 0;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if re.is_match(&name) {
            let p = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let len = meta.len();
                    if fs::remove_file(&p).is_ok() {
                        deleted += len;
                        info!("Reclaimed space: deleted {}", p.display());
                    }
                }
            }
        }
    }
    deleted
}

fn glob_to_regex(glob: &str) -> String {
    let mut s = String::from("(?i)^");
    for c in glob.chars() {
        match c {
            '*' => s.push_str(".*"),
            '?' => s.push('.'),
            '.' => s.push_str("\\."),
            '[' => s.push('['),
            ']' => s.push(']'),
            other => s.push(other),
        }
    }
    s.push('$');
    s
}

fn find_primary_rar(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;

    let mut rars = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let Some(file_name) = p.file_name() else {
            continue;
        };
        let name = file_name.to_string_lossy().to_lowercase();
        if name.ends_with(".part01.rar") || name.ends_with(".part1.rar") {
            return Some(p);
        }
        if name.ends_with(".rar") {
            rars.push(p);
        }
    }

    rars.sort();
    rars.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_7z_progress() {
        assert_eq!(parse_7z_progress("  0%"), Some(0));
        assert_eq!(parse_7z_progress("  45% 120/300 files..."), Some(45));
        assert_eq!(parse_7z_progress(" 100%"), Some(100));
        assert_eq!(parse_7z_progress("Extracting archive: file.rar"), None);
        assert_eq!(parse_7z_progress("Everything is Ok"), None);
    }

    #[test]
    fn test_parse_innoextract_progress() {
        assert_eq!(
            parse_innoextract_progress("[  5%] Extracting file"),
            Some(5)
        );
        assert_eq!(
            parse_innoextract_progress("[ 75%] Extracting file"),
            Some(75)
        );
        assert_eq!(parse_innoextract_progress("[100%] Done"), Some(100));
    }

    #[test]
    fn test_overlay_directory() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        let dest = temp.path().join("dest");

        fs::create_dir_all(src.join("sub")).unwrap();
        fs::create_dir_all(dest.join("sub")).unwrap();

        fs::write(src.join("sub/steam_api64.dll"), "cracked").unwrap();
        fs::write(dest.join("sub/steam_api64.dll"), "original").unwrap();
        fs::write(dest.join("sub/game.exe"), "executable").unwrap();

        overlay_directory(&src, &dest).unwrap();

        let updated = fs::read_to_string(dest.join("sub/steam_api64.dll")).unwrap();
        assert_eq!(updated, "cracked");

        let preserved = fs::read_to_string(dest.join("sub/game.exe")).unwrap();
        assert_eq!(preserved, "executable");
    }

    #[test]
    fn test_calculate_and_delete_pattern() {
        let temp = tempfile::tempdir().unwrap();
        let p1 = temp.path().join("game.part01.rar");
        let p2 = temp.path().join("game.part02.rar");
        let keep = temp.path().join("game.exe");

        fs::write(&p1, vec![0u8; 1024]).unwrap();
        fs::write(&p2, vec![0u8; 2048]).unwrap();
        fs::write(&keep, vec![0u8; 4096]).unwrap();

        let size = calculate_pattern_size(temp.path(), "*.rar");
        assert_eq!(size, 3072);

        let deleted = delete_pattern(temp.path(), "*.rar");
        assert_eq!(deleted, 3072);

        assert!(!p1.exists());
        assert!(!p2.exists());
        assert!(keep.exists());
    }

    #[test]
    fn test_materialize_setup_script() {
        let temp = tempfile::tempdir().unwrap();
        let manifest = serde_json::json!({
            "recipe": {
                "distributionType": "ArchiveBundle",
                "steps": [],
                "targetExecutable": "Game.exe",
                "setupCommand": "drop-pipeline-setup.bat",
                "setupScriptWindows": "@echo off\necho hello\n",
                "setupScriptLinux": "#!/bin/bash\necho hello\n"
            }
        });

        let written =
            materialize_setup_script(&manifest, temp.path(), &Platform::Windows).unwrap();
        assert_eq!(written.as_deref(), Some("drop-pipeline-setup.bat"));
        let script =
            fs::read_to_string(temp.path().join("drop-pipeline-setup.bat")).unwrap();
        assert!(script.contains("echo hello"));

        assert!(
            materialize_setup_script(&serde_json::json!({}), temp.path(), &Platform::Windows)
                .unwrap()
                .is_none()
        );

        let unsafe_name = serde_json::json!({
            "recipe": {
                "distributionType": "ArchiveBundle",
                "steps": [],
                "targetExecutable": "Game.exe",
                "setupCommand": "../evil.bat",
                "setupScriptWindows": "@echo off\n"
            }
        });
        assert!(
            materialize_setup_script(&unsafe_name, temp.path(), &Platform::Windows).is_err()
        );
    }
}
