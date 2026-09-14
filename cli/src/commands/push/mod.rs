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
use serde::Serialize;
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

#[derive(Debug, Serialize)]
pub struct PushSummary {
    pub files: usize,
    pub chunks: usize,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[derive(Debug, Serialize)]
struct ChunkRef {
    sha256: String,
    original_len: usize,
    compressed_len: usize,
}

#[derive(Debug, Serialize)]
struct ManifestEntry {
    path: String,
    chunks: Vec<ChunkRef>,
}

#[derive(Debug, Serialize)]
struct PushManifest {
    version: u32,
    chunker: &'static str,
    entries: Vec<ManifestEntry>,
}

/// Chunks `path` into `out/chunks` and writes `out/manifest.json`.
pub fn run(path: &Path, out: &Path) -> Result<PushSummary> {
    let chunker = Chunker::default();
    let chunk_dir = out.join("chunks");
    fs::create_dir_all(&chunk_dir).context("creating chunk output directory")?;

    let mut entries = Vec::new();
    let mut summary = PushSummary {
        files: 0,
        chunks: 0,
        bytes_in: 0,
        bytes_out: 0,
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
            let compressed = zstd::bulk::compress(chunk, 3).context("compressing chunk")?;
            let digest = hex_digest(chunk);
            let chunk_path = chunk_dir.join(&digest);
            if !written.contains(&digest) {
                fs::write(&chunk_path, &compressed).context("writing chunk")?;
                written.insert(digest.clone());
                summary.bytes_out += compressed.len() as u64;
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
        chunker: "buzhash-cdc-v1",
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
pub fn chunk_path(out: &Path, sha256: &str) -> PathBuf {
    out.join("chunks").join(sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
}
