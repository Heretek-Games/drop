use anyhow::{Context, anyhow};

use crate::proto::version::version_response::Manifest;

fn fixed_length<T, const N: usize>(v: Vec<T>) -> Result<[T; N], anyhow::Error> {
    let len = v.len();
    v.try_into()
        .map_err(|_| anyhow!("expected a Vec of length {N} but it was {len}"))
}

/// Converts the protobuf manifest received from the Drop server into the
/// `droplet-rs` manifest used by the depot.
///
/// # Errors
///
/// Returns an error when a file offset/length does not fit `usize`, or when the
/// AES `key`/`iv` are not the expected fixed length.
pub fn convert_protobuf_manifest(
    source: Manifest,
) -> Result<droplet_rs::manifest::Manifest, anyhow::Error> {
    let chunks = source
        .chunks
        .into_iter()
        .map(|(id, chunk_data)| {
            let files = chunk_data
                .files
                .into_iter()
                .map(|file_entry| {
                    Ok(droplet_rs::manifest::FileEntry {
                        filename: file_entry.filename,
                        start: file_entry
                            .start
                            .try_into()
                            .context("chunk file start does not fit usize")?,
                        length: file_entry
                            .length
                            .try_into()
                            .context("chunk file length does not fit usize")?,
                        permissions: file_entry.permissions,
                    })
                })
                .collect::<Result<Vec<_>, anyhow::Error>>()?;

            Ok((
                id,
                droplet_rs::manifest::ChunkData {
                    files,
                    checksum: chunk_data.checksum,
                    iv: fixed_length(chunk_data.iv)?,
                },
            ))
        })
        .collect::<Result<_, anyhow::Error>>()?;

    Ok(droplet_rs::manifest::Manifest {
        version: source.version,
        chunks,
        size: source.size,
        key: fixed_length(source.key)?,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn accepts_a_well_formed_manifest() {
        let mut source = Manifest::new();
        source.key = vec![0; 16];
        source.chunks = HashMap::new();

        assert!(convert_protobuf_manifest(source).is_ok());
    }

    #[test]
    fn rejects_a_key_of_the_wrong_length() {
        let mut source = Manifest::new();
        source.key = vec![0; 8];
        source.chunks = HashMap::new();

        assert!(convert_protobuf_manifest(source).is_err());
    }
}
