//! Managed Ludusavi provisioning.
//!
//! Mirrors how `7z`/`innoextract` are provisioned into `<data>/tools/<tool>/`:
//! the desktop downloads the release archive for the host platform and drops
//! the binary there, where [`crate::LudusaviClient::discover`] finds it.
//!
//! Network access is injected (`download`) so the install logic stays testable.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use database::db::DATA_ROOT_DIR;

use crate::error::BackupError;

const RELEASES_BASE: &str = "https://github.com/mtkennerly/ludusavi/releases";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LudusaviAsset {
    pub tag: String,
    pub file_name: String,
    pub url: String,
}

/// Builds the release asset for a concrete release tag (e.g. `v0.27.0`).
pub fn asset_for(tag: &str, os: &str, arch: &str) -> Option<LudusaviAsset> {
    if tag.is_empty() {
        return None;
    }
    let arch_token = match arch {
        "x86_64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        _ => return None,
    };
    let extension = match os {
        "linux" | "macos" => "tar.gz",
        "windows" => "zip",
        _ => return None,
    };
    let file_name = format!("ludusavi-{tag}-{os}-{arch_token}.{extension}");
    Some(LudusaviAsset {
        tag: tag.to_string(),
        url: format!("{RELEASES_BASE}/download/{tag}/{file_name}"),
        file_name,
    })
}

#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
}

/// Extracts `tag_name` from a GitHub `releases/latest` response.
pub fn parse_latest_tag(json: &str) -> Result<String, BackupError> {
    let release: GithubRelease = serde_json::from_str(json)?;
    if release.tag_name.is_empty() {
        return Err(BackupError::ParseError);
    }
    Ok(release.tag_name)
}

/// `<data>/tools/ludusavi`.
pub fn tools_dir() -> PathBuf {
    DATA_ROOT_DIR.join("tools").join("ludusavi")
}

fn binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ludusavi.exe"
    } else {
        "ludusavi"
    }
}

/// Writes raw binary bytes to the tools directory and marks them executable.
pub fn install_binary(dest_dir: &Path, bytes: &[u8]) -> Result<PathBuf, BackupError> {
    fs::create_dir_all(dest_dir)?;
    let dest = dest_dir.join(binary_name());
    fs::write(&dest, bytes)?;
    make_executable(&dest)?;
    Ok(dest)
}

/// Extracts the platform binary from a downloaded archive into `dest_dir`.
///
/// Supports `.tar.gz` (Linux/macOS) and `.zip` (Windows); anything else is
/// treated as a raw binary.
pub fn install_archive(
    file_name: &str,
    bytes: &[u8],
    dest_dir: &Path,
) -> Result<PathBuf, BackupError> {
    if file_name.ends_with(".tar.gz") {
        let decompressor = flate2::read::GzDecoder::new(bytes);
        let mut archive = tar::Archive::new(decompressor);
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.to_path_buf();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name != binary_name() {
                continue;
            }
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents)?;
            return install_binary(dest_dir, &contents);
        }
        return Err(BackupError::NotFound);
    }

    install_binary(dest_dir, bytes)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), BackupError> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), BackupError> {
    Ok(())
}

/// Downloads and installs Ludusavi for a concrete release tag.
pub fn provision<F>(tag: &str, os: &str, arch: &str, download: F) -> Result<PathBuf, BackupError>
where
    F: FnOnce(&str) -> Result<Vec<u8>, BackupError>,
{
    let asset = asset_for(tag, os, arch).ok_or(BackupError::NotFound)?;
    let bytes = download(&asset.url)?;
    install_archive(&asset.file_name, &bytes, &tools_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn tar_gz_with(binary: &str, contents: &[u8]) -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, binary, contents)
                .expect("append");
            builder.finish().expect("finish tar");
        }
        gz.write_all(&[]).ok();
        gz.finish().expect("finish gz")
    }

    #[test]
    fn builds_platform_asset_urls() {
        let linux = asset_for("v0.27.0", "linux", "x86_64").expect("linux asset");
        assert_eq!(linux.file_name, "ludusavi-v0.27.0-linux-x64.tar.gz");
        assert!(linux
            .url
            .ends_with("/download/v0.27.0/ludusavi-v0.27.0-linux-x64.tar.gz"));

        let mac = asset_for("v0.27.0", "macos", "aarch64").expect("mac asset");
        assert_eq!(mac.file_name, "ludusavi-v0.27.0-macos-arm64.tar.gz");

        let win = asset_for("v0.27.0", "windows", "x86_64").expect("win asset");
        assert_eq!(win.file_name, "ludusavi-v0.27.0-windows-x64.zip");

        assert!(asset_for("v0.27.0", "linux", "sparc").is_none());
        assert!(asset_for("", "linux", "x86_64").is_none());
    }

    #[test]
    fn parses_the_latest_release_tag() {
        let json = r#"{ "tag_name": "v0.27.0", "name": "v0.27.0" }"#;
        assert_eq!(parse_latest_tag(json).unwrap(), "v0.27.0");
    }

    #[test]
    fn installs_the_binary_from_a_tar_gz() {
        let dir = tempdir().unwrap();
        let archive = tar_gz_with(binary_name(), b"LUDUSAVI_BINARY");
        let path = install_archive("ludusavi-v0.27.0-linux-x64.tar.gz", &archive, dir.path())
            .expect("install");
        assert_eq!(fs::read(&path).unwrap(), b"LUDUSAVI_BINARY");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(fs::metadata(&path).unwrap().permissions().mode() & 0o111 != 0);
        }
    }

    #[test]
    fn installs_a_raw_binary() {
        let dir = tempdir().unwrap();
        let path = install_archive("ludusavi", b"RAW", dir.path()).expect("install");
        assert_eq!(fs::read(&path).unwrap(), b"RAW");
    }
}
