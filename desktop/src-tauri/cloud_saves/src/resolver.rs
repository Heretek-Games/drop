use std::{
    fs::{self, File, create_dir_all},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use crate::error::BackupError;

use super::{backup_manager::BackupHandler, placeholder::*};
use database::GameVersion;
use log::{debug, warn};
use tempfile::tempfile;

use super::{backup_manager::BackupManager, metadata::CloudSaveMetadata, normalise::normalize};

pub fn resolve(meta: &mut CloudSaveMetadata) -> File {
    let f = File::create_new("save").unwrap();
    let compressor = zstd::Encoder::new(f, 22).unwrap();
    let mut tarball = tar::Builder::new(compressor);
    let manager = BackupManager::new();
    for file in meta.files.iter_mut() {
        let id = uuid::Uuid::new_v4().to_string();
        let os = match file
            .conditions
            .iter()
            .find_map(|p| match p {
                super::conditions::Condition::Os(os) => Some(os),
                _ => None,
            })
            .cloned()
        {
            Some(os) => os,
            None => {
                warn!(
                    "File {:?} could not be backed up because it did not provide an OS",
                    file
                );
                continue;
            }
        };
        let handler = match manager.sources.get(&(manager.current_platform, os)) {
            Some(h) => *h,
            None => continue,
        };
        let t_path = PathBuf::from(normalize(&file.path, os));
        let path = match parse_path(t_path, handler, &meta.game_version) {
            Ok(path) => path,
            Err(err) => {
                warn!("Skipping save path for {:?}: {err}", file);
                continue;
            }
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) => {
                warn!("Skipping save path {}: {err}", path.display());
                continue;
            }
        };
        if metadata.is_dir() {
            if let Err(err) = tarball.append_dir_all(&id, &path) {
                warn!("Failed to archive directory {}: {err}", path.display());
                continue;
            }
        } else if metadata.is_file() {
            let mut source = match File::open(&path) {
                Ok(file) => file,
                Err(err) => {
                    warn!(
                        "Skipping {} because it could not be opened: {err}",
                        path.display()
                    );
                    continue;
                }
            };
            if let Err(err) = tarball.append_file(&id, &mut source) {
                warn!("Failed to archive file {}: {err}", path.display());
                continue;
            }
        }
        file.id = Some(id);
    }
    let binding = serde_json::to_string(meta).unwrap();
    let serialized = binding.as_bytes();
    let mut file = tempfile().unwrap();
    file.write_all(serialized).unwrap();
    tarball.append_file("metadata", &mut file).unwrap();
    tarball.into_inner().unwrap().finish().unwrap()
}

pub fn extract(file: PathBuf) -> Result<(), BackupError> {
    let tmpdir = tempfile::tempdir().unwrap();

    // Reopen the file for reading
    let file = File::open(file).unwrap();

    let decompressor = zstd::Decoder::new(file).unwrap();
    let mut f = tar::Archive::new(decompressor);
    f.unpack(tmpdir.path()).unwrap();

    let path = tmpdir.path();

    let mut manifest = File::open(path.join("metadata")).unwrap();

    let mut manifest_slice = Vec::new();
    manifest.read_to_end(&mut manifest_slice).unwrap();

    let manifest: CloudSaveMetadata = serde_json::from_slice(&manifest_slice).unwrap();

    for file in manifest.files {
        let current_path = path.join(file.id.as_ref().unwrap());

        let manager = BackupManager::new();
        let os = match file
            .conditions
            .iter()
            .find_map(|p| match p {
                super::conditions::Condition::Os(os) => Some(os),
                _ => None,
            })
            .cloned()
        {
            Some(os) => os,
            None => {
                warn!(
                    "File {:?} could not be replaced up because it did not provide an OS",
                    file
                );
                continue;
            }
        };
        let handler = match manager.sources.get(&(manager.current_platform, os)) {
            Some(h) => *h,
            None => continue,
        };

        let new_path = parse_path(file.path.into(), handler, &manifest.game_version)?;
        create_dir_all(new_path.parent().unwrap()).unwrap();

        debug!("copying extracted save file");

        copy_item(current_path, new_path).unwrap();
    }

    Ok(())
}

pub fn copy_item<P: AsRef<Path>>(src: P, dest: P) -> io::Result<()> {
    let src_path = src.as_ref();
    let dest_path = dest.as_ref();

    let metadata = fs::metadata(src_path)?;

    if metadata.is_file() {
        // Ensure the parent directory of the destination exists for a file copy
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src_path, dest_path)?;
    } else if metadata.is_dir() {
        // For directories, we call the recursive helper function.
        // The destination for the recursive copy is the `dest_path` itself.
        copy_dir_recursive(src_path, dest_path)?;
    } else {
        // Handle other file types like symlinks if necessary,
        // for now, return an error or skip.
        return Err(io::Error::other(format!(
            "Source {:?} is neither a file nor a directory",
            src_path
        )));
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> io::Result<()> {
    fs::create_dir_all(dest)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let entry_file_name = match entry_path.file_name() {
            Some(name) => name,
            None => continue, // Skip if somehow there's no file name
        };
        let dest_entry_path = dest.join(entry_file_name);
        let metadata = entry.metadata()?;

        if metadata.is_file() {
            debug!(
                "Writing file {} to {}",
                entry_path.display(),
                dest_entry_path.display()
            );
            fs::copy(&entry_path, &dest_entry_path)?;
        } else if metadata.is_dir() {
            copy_dir_recursive(&entry_path, &dest_entry_path)?;
        }
        // Ignore other types like symlinks for this basic implementation
    }

    Ok(())
}

pub fn parse_path(
    path: PathBuf,
    backup_handler: &dyn BackupHandler,
    game: &GameVersion,
) -> Result<PathBuf, BackupError> {
    let mut s = PathBuf::new();
    for component in path.components() {
        match component.as_os_str().to_str() {
            None => {
                s.push(PathBuf::from(component.as_os_str()));
                continue;
            }
            Some(component) => match component {
                ROOT => s.push(backup_handler.root_translate(&path, game)?),
                GAME => s.push(backup_handler.game_translate(&path, game)?),
                BASE => s.push(backup_handler.base_translate(&path, game)?),
                HOME => s.push(backup_handler.home_translate(&path, game)?),
                STORE_USER_ID => s.push(backup_handler.store_user_id_translate(&path, game)?),
                OS_USER_NAME => s.push(backup_handler.os_user_name_translate(&path, game)?),
                WIN_APP_DATA => s.push(backup_handler.win_app_data_translate(&path, game)?),
                WIN_LOCAL_APP_DATA => {
                    s.push(backup_handler.win_local_app_data_translate(&path, game)?)
                }
                WIN_LOCAL_APP_DATA_LOW => {
                    s.push(backup_handler.win_local_app_data_low_translate(&path, game)?)
                }
                WIN_DOCUMENTS => s.push(backup_handler.win_documents_translate(&path, game)?),
                WIN_PUBLIC => s.push(backup_handler.win_public_translate(&path, game)?),
                WIN_PROGRAM_DATA => s.push(backup_handler.win_program_data_translate(&path, game)?),
                WIN_DIR => s.push(backup_handler.win_dir_translate(&path, game)?),
                XDG_DATA => s.push(backup_handler.xdg_data_translate(&path, game)?),
                XDG_CONFIG => s.push(backup_handler.xdg_config_translate(&path, game)?),
                SKIP => s.push(backup_handler.skip_translate(&path, game)?),
                _ => s.push(PathBuf::from(component)),
            },
        }
    }

    debug!("resolved save path");
    Ok(s)
}
