#![cfg(test)]
extern crate test_generator;

use std::path::Path;

use hex::ToHex as _;
use sha2::{Digest as _, Sha256};
use test_generator::test_resources;
use tokio::io::SimplexStream;

use crate::manifest::{generate_manifest_rusty, ManifestWriterFactory};

#[test_resources("testfiles/**/*.7z")]
fn manifest_gen(resource: &str) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");

    runtime.block_on(async move {
        let filepath = Path::new(resource);
        let manifest = generate_manifest_rusty(
            filepath,
            |_| {},
            |message| {
                println!("({}) {}", filepath.display(), message);
            },
            None::<&dyn ManifestWriterFactory<Writer = SimplexStream>>, // Dummy type signature, not actually used
            None,
        )
        .await
        .unwrap_or_else(|err| {
            panic!(
                "failed to generate manifest for {}: {:?}",
                filepath.display(),
                err
            )
        });

        let first_chunk = manifest
            .chunks
            .values()
            .next()
            .expect("no chunks generated");
        let first_chunk_length = first_chunk.files.len();
        if first_chunk_length == 0 {
            panic!("{} has no files in manifest", filepath.display());
        }
    });
}

/// A UTF-8 BOM (`EF BB BF`) must survive manifest generation byte-for-byte:
/// some RPG Maker titles refuse to start when it is stripped (#438).
#[test]
fn bom_preserved_in_manifest() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to create tokio runtime");

    let temp_dir = std::env::temp_dir().join(format!("droplet-bom-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).expect("failed to create temp dir");

    let bom_contents: &[u8] = b"\xEF\xBB\xBFHello, Drop!\n";
    std::fs::write(temp_dir.join("bom.txt"), bom_contents).expect("failed to write BOM fixture");

    runtime.block_on(async {
        let manifest = generate_manifest_rusty(
            &temp_dir,
            |_| {},
            |_| {},
            None::<&dyn ManifestWriterFactory<Writer = SimplexStream>>, // Dummy type signature, not actually used
            None,
        )
        .await
        .expect("failed to generate manifest");

        let file = manifest
            .chunks
            .values()
            .flat_map(|chunk| chunk.files.iter())
            .find(|file| file.filename == "bom.txt")
            .expect("bom.txt missing from manifest");
        assert_eq!(file.length as usize, bom_contents.len());

        let expected = Sha256::digest(bom_contents).encode_hex::<String>();
        assert!(
            manifest
                .chunks
                .values()
                .any(|chunk| chunk.checksum == expected),
            "chunk checksum does not match the raw BOM bytes, contents were altered",
        );
    });

    std::fs::remove_dir_all(&temp_dir).ok();
}
