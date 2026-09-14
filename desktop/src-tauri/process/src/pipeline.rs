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
    db::DATA_ROOT_DIR,
    models::data::{InstalledGameType, SetupConfiguration},
    platform::Platform,
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

/// Whether a pipeline setup is currently running for `game_id`.
pub fn pipeline_is_running(game_id: &str) -> bool {
    RUNNING_PIPELINES.lock().contains_key(game_id)
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

    let mut recipe: PipelineRecipe = serde_json::from_value(recipe_value.clone())
        .map_err(|e| format!("Failed to parse pipeline recipe: {e}"))?;

    append_admin_setup_steps(&mut recipe, &version.setups, &meta.target_platform);

    Ok(PreparedPipeline {
        recipe,
        install_dir,
        meta,
    })
}

/// Appends admin-provided setup executables as ordered `run_command` steps
/// after the generated install steps, so secondary installers (DLC, bonus
/// content) run once the base installation finishes (#352).
///
/// The generated `drop-pipeline-setup.*` fallback script is skipped: the recipe
/// already performs those steps natively. Steps that already run the same
/// command are skipped too, keeping the pipeline idempotent.
fn append_admin_setup_steps(
    recipe: &mut PipelineRecipe,
    setups: &[SetupConfiguration],
    target_platform: &Platform,
) {
    const GENERATED_SETUP_SCRIPTS: [&str; 2] =
        ["drop-pipeline-setup.bat", "drop-pipeline-setup.sh"];

    for (index, setup) in setups
        .iter()
        .filter(|setup| setup.platform == *target_platform)
        .enumerate()
    {
        let basename = Path::new(&setup.command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(setup.command.as_str());
        if GENERATED_SETUP_SCRIPTS
            .iter()
            .any(|script| script.eq_ignore_ascii_case(basename))
        {
            continue;
        }

        if recipe
            .setup_command
            .as_deref()
            .is_some_and(|command| command == setup.command.as_str())
        {
            continue;
        }

        let already_runs = recipe.steps.iter().any(|step| {
            step.action == PipelineStepAction::RunCommand
                && step
                    .params
                    .get("command")
                    .and_then(|value| value.as_str())
                    .is_some_and(|command| command == setup.command.as_str())
        });
        if already_runs {
            continue;
        }

        recipe.steps.push(PipelineStep {
            id: format!("admin_setup_{index}"),
            action: PipelineStepAction::RunCommand,
            params: HashMap::from([(
                "command".to_owned(),
                serde_json::Value::String(setup.command.clone()),
            )]),
            description: format!("Run additional setup executable: {}", setup.command),
            optional: false,
        });
    }
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

    crate::path_guard::write_file(install_dir, &name, script.as_bytes())
        .map_err(|e| format!("failed to write {name}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = crate::path_guard::safe_join(install_dir, &name)
            .map_err(|e| format!("failed to resolve {name}: {e}"))?;
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
    {
        let mut running = RUNNING_PIPELINES.lock();
        if running.contains_key(&game_id) {
            return Err(format!("A pipeline is already running for game {game_id}"));
        }
        running.insert(game_id.clone(), cancel_flag.clone());
    }

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

    let run_result: Result<(), String> = 'steps: {
        for (step_index, step) in recipe.steps.iter().enumerate() {
            if cancel_flag.load(Ordering::SeqCst) {
                break 'steps Err("Pipeline setup cancelled by user".to_string());
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
                PipelineStepAction::RunCommand => {
                    execute_run_command(
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
                PipelineStepAction::Unknown => {
                    warn!("Skipping unknown step action: {:?}", step.action);
                    Ok(())
                }
            };

            if let Err(err) = step_res {
                if step.optional {
                    warn!("Optional step {} failed, continuing: {}", step.id, err);
                } else {
                    break 'steps Err(format!("Step '{}' failed: {}", step.id, err));
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

        Ok(())
    };

    // Remove the temporary extraction directory in every outcome: on success it
    // is no longer needed, and on failure/cancellation leaving it behind wastes
    // disk and can confuse a later run.
    if let Err(err) = crate::path_guard::remove_dir_all(install_dir, ".drop_iso_tmp") {
        debug!("failed to remove temporary extraction directory: {err}");
    }

    run_result?;

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
        Some(name) if !name.contains(['*', '?']) => {
            crate::path_guard::safe_join(install_dir, name).map_err(|e| e.to_string())?
        }
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

    let output_dir = crate::path_guard::ensure_dir(install_dir, output_sub)
        .map_err(|e| format!("Refusing unsafe output directory '{output_sub}': {e}"))?;

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
    let output_dir = crate::path_guard::ensure_dir(install_dir, output_sub)
        .map_err(|e| format!("Refusing unsafe output directory '{output_sub}': {e}"))?;

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
                crate::path_guard::safe_join(install_dir, rel).map_err(|e| e.to_string())?
            });
        }
        let iso_dir_sub = step
            .params
            .get("isoDir")
            .and_then(|v| v.as_str())
            .unwrap_or(".drop_iso_tmp");
        if let Ok(dir) = crate::path_guard::safe_join(install_dir, iso_dir_sub) {
            dirs.push(dir);
        }
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
    let output_dir = crate::path_guard::ensure_dir(install_dir, output_sub)
        .map_err(|e| format!("Refusing unsafe output directory '{output_sub}': {e}"))?;

    let archive_path =
        crate::path_guard::safe_join(install_dir, archive_name).map_err(|e| e.to_string())?;
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
    let output_dir = crate::path_guard::ensure_dir(install_dir, output_sub)
        .map_err(|e| format!("Refusing unsafe output directory '{output_sub}': {e}"))?;

    let setup_path =
        crate::path_guard::safe_join(install_dir, setup_exe).map_err(|e| e.to_string())?;
    let mut cmd = tokio::process::Command::new(tool);
    cmd.arg("-e")
        .arg("-d")
        .arg(&output_dir)
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
        if let Some(p) = confined_dir(install_dir, c) {
            crack_dirs.push(p);
        }
        if let Some(p) = confined_dir(install_dir, &format!(".drop_iso_tmp/{c}")) {
            crack_dirs.push(p);
        }
    }

    // Also scan candidates in root and .drop_iso_tmp. `crackDir` is confined to
    // the install directory; an absolute or `..` value is ignored.
    for c in candidates {
        if let Some(p) = confined_dir(install_dir, c)
            && !crack_dirs.contains(&p)
        {
            crack_dirs.push(p);
        }
        if let Some(p) = confined_dir(install_dir, &format!(".drop_iso_tmp/{c}"))
            && !crack_dirs.contains(&p)
        {
            crack_dirs.push(p);
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
    for entry in walkdir::WalkDir::new(src_dir)
        .min_depth(1)
        .follow_links(false)
    {
        let entry = entry.map_err(|e| format!("Walkdir error: {e}"))?;
        let rel_path = entry
            .path()
            .strip_prefix(src_dir)
            .map_err(|e| format!("Strip prefix error: {e}"))?;

        if entry.file_type().is_dir() {
            crate::path_guard::ensure_dir(dest_dir, rel_path)
                .map_err(|e| format!("Failed to create dir {}: {e}", rel_path.display()))?;
        } else if entry.file_type().is_file() {
            crate::path_guard::copy_to(dest_dir, entry.path(), rel_path).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {e}",
                    entry.path().display(),
                    rel_path.display()
                )
            })?;
        }
        // Symlink entries (follow_links = false) are intentionally skipped.
    }
    Ok(())
}

/// Resolve `candidate` inside `install_dir` and return it only when it is an
/// existing directory. Absolute paths, `..` escapes and symlinked components
/// are rejected.
fn confined_dir(install_dir: &Path, candidate: &str) -> Option<PathBuf> {
    crate::path_guard::safe_join(install_dir, candidate)
        .ok()
        .filter(|path| path.is_dir())
}

async fn execute_cleanup_step(step: &PipelineStep, install_dir: &Path) -> Result<(), String> {
    if let Some(serde_json::Value::Array(targets)) = step.params.get("targets") {
        for t in targets {
            if let Some(pattern) = t.as_str() {
                // Targets without a wildcard may be directories (e.g. .drop_iso_tmp).
                if !pattern.contains(['*', '?', '[']) {
                    let dir = match crate::path_guard::safe_join(install_dir, pattern) {
                        Ok(dir) => dir,
                        Err(e) => {
                            warn!("Refusing cleanup target: {e}");
                            continue;
                        }
                    };
                    if dir.is_dir() {
                        if let Err(e) = crate::path_guard::remove_dir_all(install_dir, pattern) {
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

#[allow(clippy::too_many_arguments)]
async fn execute_run_command(
    app_handle: &AppHandle,
    game_id: &str,
    step_index: usize,
    total_steps: usize,
    step: &PipelineStep,
    install_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
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

    // A recipe command may only run a binary that stays inside the install
    // directory; it must never fall back to an arbitrary PATH binary.
    let program = resolve_command_program(install_dir, &parts[0])?;

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&parts[1..])
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
        |_| None,
    )
    .await
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

    // Poll the cancel flag on a timer as well as per stdout line so a child
    // that emits no output (a stuck 7z or GUI installer) can still be stopped.
    let mut cancel_tick = tokio::time::interval(std::time::Duration::from_millis(200));
    cancel_tick.tick().await;

    loop {
        tokio::select! {
            line = reader.next_line() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(e) => return Err(e.to_string()),
                };

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
            _ = cancel_tick.tick() => {
                if cancel_flag.load(Ordering::SeqCst) {
                    let _ = kill_process_tree(&mut child).await;
                    stderr_task.abort();
                    return Err("Operation cancelled by user".to_string());
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Process wait failed: {e}"))?;
    // A grandchild can keep stderr open after the parent exits; do not hang on
    // it forever after the process itself has finished.
    let stderr_lines =
        match tokio::time::timeout(std::time::Duration::from_secs(5), stderr_task).await {
            Ok(Ok(lines)) => lines,
            _ => Vec::new(),
        };
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
    if let Err(err) = crate::path_guard::remove_dir_all(install_dir, ".drop_iso_tmp") {
        debug!("failed to remove temporary extraction directory: {err}");
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
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    let len = meta.len();
                    if crate::path_guard::remove_file(base_dir, &name).is_ok() {
                        deleted += len;
                        info!("Reclaimed space: deleted {}", entry.path().display());
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
            // Everything else is a literal: release filenames commonly contain
            // brackets and parentheses that would otherwise change the pattern.
            other => s.push_str(&regex::escape(&other.to_string())),
        }
    }
    s.push('$');
    s
}

/// Resolve the program for a `run_command` step.
///
/// A path-like or absolute target must stay inside `install_dir`; a bare name
/// is only accepted when the file exists inside `install_dir`. There is
/// deliberately no PATH fallback, so a crafted recipe cannot run an arbitrary
/// system binary.
fn resolve_command_program(install_dir: &Path, program: &str) -> Result<PathBuf, String> {
    if program.is_empty() {
        return Err("run_command program is empty".to_string());
    }
    let path = Path::new(program);
    if path.is_absolute() || program.contains(['/', '\\']) {
        return crate::path_guard::safe_join(install_dir, program)
            .map_err(|e| format!("refusing command '{program}': {e}"));
    }
    let candidate = crate::path_guard::safe_join(install_dir, program)
        .map_err(|e| format!("refusing command '{program}': {e}"))?;
    if candidate.is_file() {
        Ok(candidate)
    } else {
        Err(format!(
            "command '{program}' was not found in the install directory"
        ))
    }
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

    fn setup(command: &str, platform: Platform) -> SetupConfiguration {
        SetupConfiguration {
            command: command.to_owned(),
            platform,
        }
    }

    fn empty_recipe() -> PipelineRecipe {
        PipelineRecipe {
            version: "1".to_owned(),
            distribution_type: DistributionType::LoosePortable,
            release_group: None,
            steps: Vec::new(),
            target_executable: "game.exe".to_owned(),
            target_args: Vec::new(),
            setup_command: Some("drop-pipeline-setup.bat".to_owned()),
            setup_script_windows: None,
            setup_script_linux: None,
        }
    }

    fn run_command_step(command: &str) -> PipelineStep {
        PipelineStep {
            id: format!("existing_{command}"),
            action: PipelineStepAction::RunCommand,
            params: HashMap::from([(
                "command".to_owned(),
                serde_json::Value::String(command.to_owned()),
            )]),
            description: format!("Run {command}"),
            optional: false,
        }
    }

    #[test]
    fn test_append_admin_setup_steps_orders_and_dedupes() {
        let mut recipe = empty_recipe();
        recipe.steps.push(run_command_step("base-setup.exe"));
        let setups = vec![
            setup("dlc-1.exe", Platform::Windows),
            setup("base-setup.exe", Platform::Windows),
            setup("linux-extra.sh", Platform::Linux),
            setup("drop-pipeline-setup.bat", Platform::Windows),
            setup("dlc-2.exe", Platform::Windows),
        ];

        append_admin_setup_steps(&mut recipe, &setups, &Platform::Windows);

        let appended: Vec<String> = recipe
            .steps
            .iter()
            .filter(|step| step.id.starts_with("admin_setup_"))
            .map(|step| {
                step.params
                    .get("command")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        assert_eq!(appended, vec!["dlc-1.exe", "dlc-2.exe"]);
        assert_eq!(
            recipe.steps.last().map(|step| step.id.as_str()),
            Some("admin_setup_4")
        );
    }

    #[test]
    fn test_append_admin_setup_steps_skips_recipe_setup_command() {
        let mut recipe = empty_recipe();
        let setups = vec![setup("drop-pipeline-setup.bat", Platform::Linux)];

        append_admin_setup_steps(&mut recipe, &setups, &Platform::Linux);

        assert!(recipe.steps.is_empty());
    }

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
    fn test_glob_to_regex_escapes_literals() {
        let re = Regex::new(&glob_to_regex("10 Dead Doves v1.2 [Build 17332128].7z")).unwrap();
        assert!(re.is_match("10 Dead Doves v1.2 [Build 17332128].7z"));
        assert!(!re.is_match("10 Dead Doves v1.2 B.7z"));

        let re = Regex::new(&glob_to_regex("Setup (64bit).exe")).unwrap();
        assert!(re.is_match("Setup (64bit).exe"));
        assert!(!re.is_match("Setup 64bit.exe"));

        let re = Regex::new(&glob_to_regex("*.r0*")).unwrap();
        assert!(re.is_match("Game.r00"));
    }

    #[test]
    fn test_safe_join_rejects_escapes() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();

        assert!(crate::path_guard::safe_join(base, "sub/file.dll").is_ok());
        assert!(crate::path_guard::safe_join(base, ".").is_ok());
        assert!(crate::path_guard::safe_join(base, "../outside").is_err());
        assert!(crate::path_guard::safe_join(base, "sub/../../outside").is_err());
        assert!(crate::path_guard::safe_join(base, "/etc/passwd").is_err());
    }

    #[test]
    fn test_resolve_command_program_refuses_path_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();

        // Bare name that exists in the install dir is allowed.
        fs::write(base.join("setup.exe"), b"x").unwrap();
        assert!(resolve_command_program(base, "setup.exe").is_ok());

        // Bare name not present must not fall back to PATH (e.g. `sh`).
        assert!(resolve_command_program(base, "sh").is_err());
        assert!(resolve_command_program(base, "../../bin/sh").is_err());
        assert!(resolve_command_program(base, "/bin/sh").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_overlay_directory_rejects_symlinked_destination() {
        let temp = tempfile::tempdir().unwrap();
        let src = temp.path().join("src");
        let dest = temp.path().join("dest");
        let outside = temp.path().join("outside");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dest).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(src.join("evil.dll"), b"pwned").unwrap();
        std::os::unix::fs::symlink(outside.join("evil.dll"), dest.join("evil.dll")).unwrap();

        assert!(overlay_directory(&src, &dest).is_err());
        assert!(!outside.join("evil.dll").exists());
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

        let written = materialize_setup_script(&manifest, temp.path(), &Platform::Windows).unwrap();
        assert_eq!(written.as_deref(), Some("drop-pipeline-setup.bat"));
        let script = fs::read_to_string(temp.path().join("drop-pipeline-setup.bat")).unwrap();
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
        assert!(materialize_setup_script(&unsafe_name, temp.path(), &Platform::Windows).is_err());
    }
}
