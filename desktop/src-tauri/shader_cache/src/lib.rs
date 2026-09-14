//! DXVK/VKD3D shader-cache discovery (Phase 1, #17).
//!
//! DXVK writes `*.dxvk-cache` state caches next to the executable or inside the
//! Proton/UMU prefix. The core client locates and collects them so they can be
//! uploaded to a community index (see the `drop-gamebox` plugin) or restored on
//! another machine.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

pub const SHADER_CACHE_EXTENSION: &str = "dxvk-cache";

/// Whether a path is a DXVK/VKD3D state cache file.
#[must_use]
pub fn is_shader_cache_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(SHADER_CACHE_EXTENSION))
}

/// Finds state cache files under the install directory and any extra roots
/// (typically the Proton/UMU prefix `drive_c` tree). Results are sorted and
/// deduplicated.
#[must_use]
pub fn find_shader_caches(install_dir: &Path, extra_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = vec![install_dir.to_path_buf()];
    roots.extend(extra_roots.iter().cloned());

    let mut found = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
            if entry.file_type().is_file() && is_shader_cache_file(entry.path()) {
                found.push(entry.path().to_path_buf());
            }
        }
    }

    found.sort();
    found.dedup();
    found
}

/// Copies every discovered cache file into `dest`, returning the copied paths.
/// Filenames are flattened with a numeric suffix on collision.
pub fn collect_shader_caches(
    install_dir: &Path,
    extra_roots: &[PathBuf],
    dest: &Path,
) -> io::Result<Vec<PathBuf>> {
    fs::create_dir_all(dest)?;

    let mut copied = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for source in find_shader_caches(install_dir, extra_roots) {
        let base = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("shader.dxvk-cache");
        let mut name = base.to_string();
        let mut counter = 1;
        while !seen.insert(name.clone()) {
            name = format!("{counter}-{base}");
            counter += 1;
        }
        let target = dest.join(&name);
        fs::copy(&source, &target)?;
        copied.push(target);
    }

    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn recognizes_only_dxvk_cache_files() {
        assert!(is_shader_cache_file(Path::new("elden-ring.dxvk-cache")));
        assert!(is_shader_cache_file(Path::new("GAME.DXVK-CACHE")));
        assert!(!is_shader_cache_file(Path::new("game.exe")));
        assert!(!is_shader_cache_file(Path::new("no-extension")));
    }

    #[test]
    fn finds_caches_across_install_and_prefix_roots() {
        let install = tempdir().unwrap();
        let prefix = tempdir().unwrap();
        fs::create_dir_all(install.path().join("bin")).unwrap();
        fs::create_dir_all(prefix.path().join("drive_c/temp")).unwrap();

        fs::write(install.path().join("bin/game.dxvk-cache"), b"cache-a").unwrap();
        fs::write(
            prefix.path().join("drive_c/temp/game.dxvk-cache"),
            b"cache-b",
        )
        .unwrap();
        fs::write(install.path().join("bin/game.exe"), b"exe").unwrap();

        let found = find_shader_caches(install.path(), &[prefix.path().to_path_buf()]);
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn collects_caches_with_collision_safe_names() {
        let install = tempdir().unwrap();
        let prefix = tempdir().unwrap();
        let dest = tempdir().unwrap();
        fs::create_dir_all(install.path().join("a")).unwrap();
        fs::create_dir_all(prefix.path().join("b")).unwrap();
        fs::write(install.path().join("a/game.dxvk-cache"), b"one").unwrap();
        fs::write(prefix.path().join("b/game.dxvk-cache"), b"two").unwrap();

        let copied =
            collect_shader_caches(install.path(), &[prefix.path().to_path_buf()], dest.path())
                .unwrap();
        assert_eq!(copied.len(), 2);
        let names: Vec<String> = copied
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"game.dxvk-cache".to_string()));
        assert!(names.contains(&"1-game.dxvk-cache".to_string()));
    }
}
