use std::path::{Path, PathBuf};

fn extra_roots(prefix_dir: Option<String>) -> Vec<PathBuf> {
    prefix_dir
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .collect()
}

/// Lists DXVK/VKD3D state cache files for a game (install dir + optional prefix).
#[tauri::command]
pub fn list_shader_caches(install_dir: String, prefix_dir: Option<String>) -> Vec<String> {
    shader_cache::find_shader_caches(Path::new(&install_dir), &extra_roots(prefix_dir))
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

/// Copies a game's shader caches into `dest` for upload to a community index.
#[tauri::command]
pub fn export_shader_caches(
    install_dir: String,
    prefix_dir: Option<String>,
    dest: String,
) -> Result<Vec<String>, String> {
    shader_cache::collect_shader_caches(
        Path::new(&install_dir),
        &extra_roots(prefix_dir),
        Path::new(&dest),
    )
    .map(|paths| {
        paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect()
    })
    .map_err(|err| err.to_string())
}
