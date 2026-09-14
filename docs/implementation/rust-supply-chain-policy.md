# Rust supply-chain policy (cargo-deny)

`cargo-deny` runs from the repository root `deny.toml` for every Rust crate in
the repo. The `cargo-deny` job in `.github/workflows/security.yml` uses the same
matrix as `cargo-audit`:

`cli`, `torrential`, `desktop/src-tauri`, `libraries/droplet`,
`libraries/droplet_types`, `libraries/libarchive`, `libraries/native_model`.

`cargo-deny` walks up from the crate directory to find the root `deny.toml`.
Vendored crates that gitignore their `Cargo.lock` (`libraries/libarchive`,
`libraries/native_model`) get a generated lockfile in CI, matching how
`cargo-audit` already runs.

## Policy

- **advisories**: vulnerabilities fail; unmaintained advisories are scoped with
  `unmaintained = "workspace"`. Only unmaintained crates the workspace depends
  on directly fail the gate. The transitive unmaintained stack pulled in by
  Tauri/GTK/async runtime crates (`async-std`, `instant`, `proc-macro-error`,
  `unic-*`, …) is still reported by the weekly `cargo-audit` job and can only be
  retired upstream.
- **licenses**: permissive licenses and AGPL variants are allowed. First-party
  crates must declare a license; all workspace manifests now declare
  `AGPL-3.0-only` (matching `torrential`, `droplet`, and `droplet_types`).
- **bans / sources**: warnings for duplicate versions (report-only), no
  wildcard bans, unknown registries and git sources denied.

## Scoped ignore

- `RUSTSEC-2025-0141` (`bincode` unmaintained): `bincode` 1.3.3/2.0.1 is a
  direct dependency of the vendored `native_model` crate for its versioned
  serialization ABI. The advisory is unmaintained-only (no known
  vulnerability), no safe upgrade exists, and changing the format would break
  stored models. Revisit when `native_model` migrates.
  `cargo-deny` reports `advisory-not-detected` warnings for this ignore in
  crates whose graphs do not contain `bincode`; the warning is informational.

## Left as-is (documented)

- Duplicate-version warnings from `[bans] multiple-versions = "warn"` remain
  report-only.
- `license-not-encountered` warnings note allow-list entries that a given crate
  graph does not use; this is expected with a shared root policy.
- The yanked `chacha20 0.10.1` entry in `desktop/src-tauri/Cargo.lock` was
  refreshed to `0.10.2` (`cargo update -p chacha20`) as part of this change.
