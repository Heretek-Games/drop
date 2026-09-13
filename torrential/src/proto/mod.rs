// Wrapper around the rust-protobuf output emitted by `build.rs` into `OUT_DIR`.
//
// Generated code is deliberately kept out of the source tree so it is rebuilt
// from `proto/*.proto` and never carries lints the crate would otherwise have to
// satisfy. The `#[allow]` attributes must stay on the module: lint levels
// propagate into the `include!`d items.
#[allow(clippy::all, clippy::pedantic, warnings)]
pub mod core {
    include!(concat!(env!("OUT_DIR"), "/proto/core.rs"));
}

#[allow(clippy::all, clippy::pedantic, warnings)]
pub mod droplet {
    include!(concat!(env!("OUT_DIR"), "/proto/droplet.rs"));
}

#[allow(clippy::all, clippy::pedantic, warnings)]
pub mod manifest {
    include!(concat!(env!("OUT_DIR"), "/proto/manifest.rs"));
}

#[allow(clippy::all, clippy::pedantic, warnings)]
pub mod version {
    include!(concat!(env!("OUT_DIR"), "/proto/version.rs"));
}
