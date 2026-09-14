//! `downpour push`: publishes a local depot directory as content-addressed,
//! zstd-compressed chunks plus a JSON manifest.
//!
//! This is the local/offline half of Phase 1 content delivery (#17): it produces
//! the same chunk layout the depot server ingests, so a later S3/HTTP uploader
//! only has to stream the emitted objects.

pub mod chunker;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use self::chunker::Chunker;

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[derive(Debug, Default, Clone)]
pub struct PushOptions {
    /// Release branch the artifacts belong to (e.g. `main`, `beta`).
    pub branch: Option<String>,
    /// Multi-platform depot the artifacts belong to (e.g. `windows`, `assets`).
    pub depot: Option<String>,
    /// Previous manifest to diff against; chunks already present there are
    /// reused instead of being written and re-uploaded.
    pub base_manifest: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
pub struct PushSummary {
    pub files: usize,
    pub chunks: usize,
    pub bytes_in: u64,
    pub bytes_out: u64,
    /// Chunks whose digest was already present in `base_manifest`.
    pub reused_chunks: usize,
    /// Chunks newly written (and therefore uploaded).
    pub new_chunks: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChunkRef {
    sha256: String,
    original_len: usize,
    compressed_len: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct ManifestEntry {
    path: String,
    chunks: Vec<ChunkRef>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PushManifest {
    version: u32,
    chunker: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    depot: Option<String>,
    entries: Vec<ManifestEntry>,
}

/// Read the set of chunk digests already published by a previous manifest.
fn read_base_chunks(manifest_path: &Path) -> Result<std::collections::HashSet<String>> {
    let bytes = fs::read(manifest_path)
        .with_context(|| format!("reading base manifest {}", manifest_path.display()))?;
    let manifest: PushManifest = serde_json::from_slice(&bytes).context("parsing base manifest")?;
    let mut digests = std::collections::HashSet::new();
    for entry in manifest.entries {
        for chunk in entry.chunks {
            digests.insert(chunk.sha256);
        }
    }
    Ok(digests)
}

/// Chunks `path` into `out/chunks` and writes `out/manifest.json`.
#[cfg(test)]
pub fn run(path: &Path, out: &Path) -> Result<PushSummary> {
    run_with_options(path, out, &PushOptions::default())
}

/// Chunks `path` and writes a manifest, reusing chunks from an optional base
/// manifest so only changed content is emitted (and later uploaded).
pub fn run_with_options(path: &Path, out: &Path, options: &PushOptions) -> Result<PushSummary> {
    let chunker = Chunker::default();
    let chunk_dir = out.join("chunks");
    fs::create_dir_all(&chunk_dir).context("creating chunk output directory")?;

    let base_chunks = match &options.base_manifest {
        Some(base) => read_base_chunks(base)?,
        None => std::collections::HashSet::new(),
    };

    let mut entries = Vec::new();
    let mut summary = PushSummary {
        files: 0,
        chunks: 0,
        bytes_in: 0,
        bytes_out: 0,
        reused_chunks: 0,
        new_chunks: 0,
    };
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(path)
            .context("stripping root prefix")?
            .to_string_lossy()
            .replace('\\', "/");
        let data = fs::read(entry.path())
            .with_context(|| format!("reading {}", entry.path().display()))?;

        summary.files += 1;
        summary.bytes_in += data.len() as u64;

        let mut chunks = Vec::new();
        for chunk in chunker.split(&data) {
            let digest = hex_digest(chunk);
            let already_published = base_chunks.contains(&digest);
            let compressed = zstd::bulk::compress(chunk, 3).context("compressing chunk")?;

            if already_published {
                summary.reused_chunks += 1;
            } else if !written.contains(&digest) {
                let chunk_path = chunk_dir.join(&digest);
                fs::write(&chunk_path, &compressed).context("writing chunk")?;
                written.insert(digest.clone());
                summary.new_chunks += 1;
                summary.bytes_out += compressed.len() as u64;
            } else {
                summary.reused_chunks += 1;
            }
            summary.chunks += 1;
            chunks.push(ChunkRef {
                sha256: digest,
                original_len: chunk.len(),
                compressed_len: compressed.len(),
            });
        }

        entries.push(ManifestEntry {
            path: relative,
            chunks,
        });
    }

    let manifest = PushManifest {
        version: 1,
        chunker: "buzhash-cdc-v1".to_string(),
        branch: options.branch.clone(),
        depot: options.depot.clone(),
        entries,
    };
    let manifest_path = out.join("manifest.json");
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).context("serializing manifest")?,
    )
    .context("writing manifest")?;

    Ok(summary)
}

/// Returns the on-disk path of a content-addressed chunk.
#[allow(dead_code)] // consumed by the S3/HTTP uploader that reuses this layout
pub fn chunk_path(out: &Path, sha256: &str) -> PathBuf {
    out.join("chunks").join(sha256)
}

/// Builds an OpenDAL operator for a storage scheme. `memory` is used by tests;
/// `s3` reads credentials from the standard environment variables.
///
/// # Errors
/// Returns an error when the scheme is unsupported or the operator cannot be
/// constructed.
pub fn build_operator(scheme: &str) -> anyhow::Result<opendal::Operator> {
    use anyhow::Context;

    match scheme {
        "memory" => Ok(opendal::Operator::new(opendal::services::Memory::default())
            .context("creating memory operator")?),
        "s3" => {
            let bucket = std::env::var("DROP_S3_BUCKET")
                .context("DROP_S3_BUCKET is required for the s3 scheme")?;
            let mut builder = opendal::services::S3::default().bucket(&bucket);
            if let Ok(region) = std::env::var("AWS_REGION") {
                builder = builder.region(&region);
            }
            if let Ok(endpoint) = std::env::var("AWS_ENDPOINT") {
                builder = builder.endpoint(&endpoint);
            }
            if let Ok(key) = std::env::var("AWS_ACCESS_KEY_ID") {
                builder = builder.access_key_id(&key);
            }
            if let Ok(secret) = std::env::var("AWS_SECRET_ACCESS_KEY") {
                builder = builder.secret_access_key(&secret);
            }
            Ok(opendal::Operator::new(builder).context("creating s3 operator")?)
        }
        other => anyhow::bail!("unsupported upload scheme '{other}'"),
    }
}

/// Uploads `dir` (chunks + manifest) under `prefix` in `operator`.
///
/// # Errors
/// Returns an error when a file cannot be read or written.
pub async fn upload_dir(
    operator: &opendal::Operator,
    prefix: &str,
    dir: &Path,
) -> anyhow::Result<usize> {
    let prefix = prefix.trim_matches('/');
    let mut uploaded = 0;

    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(dir)
            .context("stripping upload root")?
            .to_string_lossy()
            .replace('\\', "/");
        let key = if prefix.is_empty() {
            relative
        } else {
            format!("{prefix}/{relative}")
        };
        let data = fs::read(entry.path())
            .with_context(|| format!("reading {}", entry.path().display()))?;
        operator
            .write(&key, data)
            .await
            .with_context(|| format!("uploading {key}"))?;
        uploaded += 1;
    }

    Ok(uploaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn uploads_packaged_chunks_to_an_operator() {
        let input = tempdir().unwrap();
        let out = tempdir().unwrap();
        fs::write(input.path().join("a.bin"), vec![3u8; 4096]).unwrap();

        run(input.path(), out.path()).unwrap();
        let operator = build_operator("memory").unwrap();
        let uploaded = upload_dir(&operator, "depot", out.path()).await.unwrap();

        assert!(uploaded >= 2, "expected chunks + manifest");
        assert!(operator.read("depot/manifest.json").await.is_ok());
    }

    #[test]
    fn rejects_unknown_upload_schemes() {
        assert!(build_operator("ftp").is_err());
    }

    #[test]
    fn push_writes_manifest_and_reassembles_chunks() {
        let input = tempdir().unwrap();
        let out = tempdir().unwrap();

        let payload_a = vec![7u8; 150_000];
        let payload_b: Vec<u8> = (0..90_000u32).map(|i| (i % 13) as u8).collect();
        fs::write(input.path().join("a.bin"), &payload_a).unwrap();
        fs::create_dir(input.path().join("nested")).unwrap();
        fs::write(input.path().join("nested/b.bin"), &payload_b).unwrap();

        let summary = run(input.path(), out.path()).unwrap();
        assert_eq!(summary.files, 2);
        assert!(summary.chunks >= 2);
        assert!(summary.bytes_in >= (payload_a.len() + payload_b.len()) as u64);

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(out.path().join("manifest.json")).unwrap()).unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);

        // Reassemble a.bin from its content-addressed chunks.
        let a_entry = entries
            .iter()
            .find(|e| e["path"] == "a.bin")
            .expect("a.bin entry");
        let mut rebuilt = Vec::new();
        for chunk in a_entry["chunks"].as_array().unwrap() {
            let sha = chunk["sha256"].as_str().unwrap();
            let compressed = fs::read(chunk_path(out.path(), sha)).unwrap();
            let decompressed = zstd::bulk::decompress(&compressed, 8 * 1024 * 1024).unwrap();
            assert_eq!(hex_digest(&decompressed), sha);
            rebuilt.extend_from_slice(&decompressed);
        }
        assert_eq!(rebuilt, payload_a);
    }

    #[test]
    fn push_reuses_chunks_from_a_base_manifest() {
        let input = tempdir().unwrap();
        let base = tempdir().unwrap();
        let out = tempdir().unwrap();

        let original = vec![11u8; 200_000];
        fs::write(input.path().join("data.bin"), &original).unwrap();
        let first = run(input.path(), base.path()).unwrap();
        assert!(first.new_chunks >= 1);

        // Unchanged content: every chunk should be reused, nothing rewritten.
        let unchanged = run_with_options(
            input.path(),
            out.path(),
            &PushOptions {
                base_manifest: Some(base.path().join("manifest.json")),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(unchanged.new_chunks, 0);
        assert!(unchanged.reused_chunks >= 1);
        assert_eq!(unchanged.bytes_out, 0);

        // Appended content: the unchanged prefix is reused, the tail is new.
        let mut modified = original.clone();
        modified.extend_from_slice(&[99u8; 5_000]);
        fs::write(input.path().join("data.bin"), &modified).unwrap();
        let delta = run_with_options(
            input.path(),
            out.path(),
            &PushOptions {
                base_manifest: Some(base.path().join("manifest.json")),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            delta.reused_chunks >= 1,
            "unchanged prefix should be reused"
        );
        assert!(delta.new_chunks >= 1, "appended content should be new");
    }

    #[test]
    fn push_records_branch_and_depot_in_the_manifest() {
        let input = tempdir().unwrap();
        let out = tempdir().unwrap();
        fs::write(input.path().join("a.bin"), vec![1u8; 100]).unwrap();

        run_with_options(
            input.path(),
            out.path(),
            &PushOptions {
                branch: Some("beta".to_string()),
                depot: Some("windows".to_string()),
                base_manifest: None,
            },
        )
        .unwrap();

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(out.path().join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["branch"], "beta");
        assert_eq!(manifest["depot"], "windows");
    }
}
