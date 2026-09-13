// Build scripts fail the whole build on error; panicking with a message is the
// clearest signal here, so the crate-wide `expect_used` lint is not useful.
#![allow(clippy::expect_used)]

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use protobuf_codegen::Codegen;

fn main() {
    let out_dir =
        PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo")).join("proto");
    fs::create_dir_all(&out_dir).expect("failed to create generated proto directory");

    let protos: Vec<String> = fs::read_dir("./proto")
        .expect("failed to read ./proto")
        .filter_map(|entry| {
            let path = entry.expect("failed to read proto dir entry").path();
            (path.extension().is_some_and(|ext| ext == "proto")).then(|| {
                format!(
                    "proto/{}",
                    path.file_name()
                        .expect("proto file has a file name")
                        .to_string_lossy()
                )
            })
        })
        .collect();

    println!("cargo:rerun-if-changed=proto");

    Codegen::new()
        .protoc_path(
            &protoc_bin_vendored::protoc_bin_path().expect("vendored protoc is unavailable"),
        )
        .inputs(protos)
        .include("proto")
        .out_dir(&out_dir)
        .run()
        .expect("protobuf code generation failed");

    strip_inner_attributes(&out_dir);
}

/// `include!` rejects inner attributes (`#![...]`) in the included file, so drop
/// the generator's lint/cfg header. `src/proto/mod.rs` applies the equivalent
/// allows at the module level.
fn strip_inner_attributes(dir: &Path) {
    for entry in fs::read_dir(dir).expect("failed to read generated proto directory") {
        let path = entry.expect("failed to read generated file").path();
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }

        let contents = fs::read_to_string(&path).expect("failed to read generated file");
        let stripped = contents
            .lines()
            .filter(|line| {
                let trimmed = line.trim_start();
                !trimmed.starts_with("#![")
                    && !trimmed.starts_with("//!")
                    && !trimmed.starts_with("/*!")
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, stripped).expect("failed to strip generated file");
    }
}
