use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use database::borrow_db_checked;
use process::path_guard;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::process::Command as TokioCommand;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedExecutable {
    pub relative_path: String,
    pub sha256: String,
    pub size: u64,
}

/// Per-plugin allowlist of bare executable names a client plugin may run via
/// `ctx.system.run`. Populated from `manifest.client.commands` by the host when
/// a plugin is registered; the Tauri command layer is the enforcement point so
/// a plugin cannot bypass it from the webview.
#[derive(Default)]
pub struct PluginCommandAllowlist(pub Mutex<HashMap<String, HashSet<String>>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

const BLOCKED_COMMANDS: &[&str] = &[
    // Shells
    "sh",
    "bash",
    "dash",
    "ash",
    "zsh",
    "csh",
    "tcsh",
    "fish",
    "ksh",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "wscript",
    "wscript.exe",
    "cscript",
    "cscript.exe",
    // Interpreters & runtimes
    "python",
    "python3",
    "python.exe",
    "python3.exe",
    "py",
    "py.exe",
    "node",
    "node.exe",
    "deno",
    "deno.exe",
    "bun",
    "bun.exe",
    "perl",
    "perl.exe",
    "ruby",
    "ruby.exe",
    "php",
    "php.exe",
    "lua",
    "lua.exe",
    // Network transfer / remote shells
    "curl",
    "curl.exe",
    "wget",
    "wget.exe",
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "ssh",
    "scp",
    "sftp",
    "ftp",
    // Privilege escalation / execution
    "sudo",
    "su",
    "doas",
    "pkexec",
    "runas",
    "runas.exe",
    // Destructive filesystem / partition / system tools
    "rm",
    "rmdir",
    "del",
    "erase",
    "dd",
    "format",
    "mkfs",
    "fdisk",
    "parted",
    "reg",
    "reg.exe",
    "regedit",
    "regedit.exe",
    "certutil",
    "certutil.exe",
    "bitsadmin",
    "bitsadmin.exe",
    "mshta",
    "mshta.exe",
    "rundll32",
    "rundll32.exe",
];

fn validate_command_name(command: &str) -> Result<(), String> {
    if command.is_empty() || command.len() > 64 {
        return Err(format!("invalid command length: '{command}'"));
    }
    if command.starts_with('.') || command.starts_with('-') {
        return Err(format!("command cannot start with '.' or '-': '{command}'"));
    }
    if !command
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(format!(
            "command contains disallowed characters (only alphanumeric, _, -, . allowed): '{command}'"
        ));
    }
    let lower = command.to_ascii_lowercase();
    if BLOCKED_COMMANDS.contains(&lower.as_str()) {
        return Err(format!(
            "command '{command}' is blocked for security reasons"
        ));
    }
    Ok(())
}

/// Register (replace) the allowlisted commands for a plugin.
#[tauri::command]
pub fn plugin_register_commands(
    plugin_id: String,
    commands: Vec<String>,
    state: State<'_, PluginCommandAllowlist>,
) -> Result<(), String> {
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "plugin command registry poisoned".to_string())?;
    let entry = registry.entry(plugin_id).or_default();
    entry.clear();
    for command in commands {
        let command = command.trim();
        if command.is_empty() {
            continue;
        }
        // Only bare executable names are allowed; no paths, so an allowlist
        // entry cannot be used to traverse to an arbitrary binary.
        if command.contains('/') || command.contains('\\') {
            return Err(format!(
                "allowlisted command must be a bare executable name: {command}"
            ));
        }
        validate_command_name(command)?;
        entry.insert(command.to_string());
    }
    Ok(())
}

/// Run an allowlisted native command for a plugin. The binary is executed
/// directly (no shell), so shell metacharacters are never interpreted.
#[tauri::command]
pub async fn plugin_system_run(
    plugin_id: String,
    bin: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    state: State<'_, PluginCommandAllowlist>,
) -> Result<CommandOutput, String> {
    validate_command_name(&bin)?;
    {
        let registry = state
            .0
            .lock()
            .map_err(|_| "plugin command registry poisoned".to_string())?;
        let allowed = registry
            .get(&plugin_id)
            .map(|set| set.contains(&bin))
            .unwrap_or(false);
        if !allowed {
            return Err(format!(
                "command '{bin}' is not allowlisted for plugin '{plugin_id}'"
            ));
        }
    }

    let mut command = TokioCommand::new(&bin);
    command
        .args(args.unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    // Clamp to [1ms, 120s] so a plugin cannot request an unbounded process.
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1, 120_000));
    let output = match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => return Err(format!("failed to run '{bin}': {err}")),
        Err(_) => return Err(format!("'{bin}' timed out after {}ms", timeout.as_millis())),
    };

    Ok(CommandOutput {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn get_game_install_dir(game_id: &str) -> Result<PathBuf, String> {
    let db = borrow_db_checked();
    if let Some(database::GameDownloadStatus::Installed { install_dir, .. }) =
        db.applications.game_statuses.get(game_id)
    {
        let path = PathBuf::from(install_dir);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "Game install directory does not exist: {}",
            path.display()
        ));
    }
    Err(format!(
        "Game with id '{game_id}' is not installed or not found in local database"
    ))
}

fn compute_file_sha256(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn plugin_game_fs_read(
    game_id: String,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let safe_path = path_guard::safe_join(&install_dir, &relative_path)
        .map_err(|e| format!("Security check failed: {e}"))?;

    fs::read(&safe_path).map_err(|e| format!("Failed to read {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_fs_write(
    game_id: String,
    relative_path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    path_guard::write_file(&install_dir, &relative_path, &data)
        .map_err(|e| format!("Failed to write {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_fs_backup(
    game_id: String,
    relative_path: String,
) -> Result<String, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let src_path = path_guard::safe_join(&install_dir, &relative_path)
        .map_err(|e| format!("Security check failed: {e}"))?;

    if !src_path.exists() {
        return Err(format!(
            "Cannot backup nonexistent file: {}",
            src_path.display()
        ));
    }

    let backup_relative = format!("{}.drop-backup", relative_path);
    path_guard::copy_to(&install_dir, &src_path, &backup_relative)
        .map_err(|e| format!("Failed to create backup {backup_relative}: {e}"))?;

    Ok(backup_relative)
}

#[tauri::command]
pub async fn plugin_game_fs_restore(game_id: String, relative_path: String) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let backup_relative = format!("{}.drop-backup", relative_path);
    let backup_path = path_guard::safe_join(&install_dir, &backup_relative)
        .map_err(|e| format!("Security check failed: {e}"))?;

    if !backup_path.exists() {
        return Err(format!(
            "Cannot restore missing backup file: {backup_relative}"
        ));
    }

    path_guard::copy_to(&install_dir, &backup_path, &relative_path)
        .map_err(|e| format!("Failed to restore file from backup: {e}"))?;

    // Cleanup backup file
    let _ = path_guard::remove_file(&install_dir, &backup_relative);

    Ok(())
}

#[tauri::command]
pub async fn plugin_game_fs_exists(game_id: String, relative_path: String) -> Result<bool, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    match path_guard::safe_join(&install_dir, &relative_path) {
        Ok(safe_path) => Ok(safe_path.exists()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn plugin_game_fs_delete(game_id: String, relative_path: String) -> Result<(), String> {
    let install_dir = get_game_install_dir(&game_id)?;
    path_guard::remove_file(&install_dir, &relative_path)
        .map_err(|e| format!("Failed to delete {relative_path}: {e}"))
}

#[tauri::command]
pub async fn plugin_game_scan_executables(
    game_id: String,
) -> Result<Vec<ScannedExecutable>, String> {
    let install_dir = get_game_install_dir(&game_id)?;
    let mut executables = Vec::new();

    for entry in WalkDir::new(&install_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        // Never follow or scan symlinks for executable security
        if path_guard::is_symlink(path) {
            continue;
        }

        let is_exec = if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            let lower = ext.to_lowercase();
            matches!(
                lower.as_str(),
                "exe" | "dll" | "so" | "bin" | "x86_64" | "elf" | "dylib"
            )
        } else {
            false
        };

        #[cfg(unix)]
        let is_exec = is_exec || {
            use std::os::unix::fs::PermissionsExt;
            entry
                .metadata()
                .map(|m| (m.permissions().mode() & 0o111) != 0)
                .unwrap_or(false)
        };

        if is_exec && let Ok(rel_path) = path.strip_prefix(&install_dir) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let sha256 =
                compute_file_sha256(path).unwrap_or_else(|_| String::from("unknown-sha256"));

            executables.push(ScannedExecutable {
                relative_path: rel_path.to_string_lossy().to_string(),
                sha256,
                size,
            });
        }
    }

    Ok(executables)
}

/// Find files inside an installed game whose relative path contains any of the
/// supplied patterns (case-insensitive substring). The host is deliberately
/// agnostic about what the patterns mean, so domain knowledge (e.g. which paths
/// indicate a particular anti-cheat or compatibility tool) lives in the calling
/// plugin, not in core. Symlinks are never followed.
#[tauri::command]
pub async fn plugin_game_find_files(
    game_id: String,
    patterns: Vec<String>,
) -> Result<Vec<String>, String> {
    let install_dir = get_game_install_dir(&game_id)?;

    let normalized: Vec<String> = patterns
        .into_iter()
        .map(|pattern| pattern.trim().to_ascii_lowercase())
        .filter(|pattern| !pattern.is_empty() && pattern.len() <= 128)
        .collect();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    for entry in WalkDir::new(&install_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || path_guard::is_symlink(path) {
            continue;
        }

        let Ok(rel) = path.strip_prefix(&install_dir) else {
            continue;
        };
        let rel_str = rel.to_string_lossy().to_ascii_lowercase();
        if normalized.iter().any(|pattern| rel_str.contains(pattern)) {
            matches.push(rel.to_string_lossy().to_string());
        }
    }

    Ok(matches)
}
