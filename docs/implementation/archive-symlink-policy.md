# Archive extraction symlink policy

## Threat

Game recipes extract untrusted release archives with 7-Zip (`7z x -y -bsp1`) and
innoextract directly into the install directory. Both tools honor symlink entries
stored in an archive. `path_guard` only protects writes Drop performs itself
(`safe_join`, `write_file`, `copy_to`, `ensure_dir`) and `overlay_directory`
skips symlink entries, so a link planted by the extractor bypasses every guard.
A link such as `../../.ssh/authorized_keys` or an absolute path to a user
document can be followed by later pipeline steps, the game, or the user.

## Policy

After every successful external extraction step (`extract_rar`, `extract_iso`,
`extract_archive`, `innoextract`) the pipeline sweeps the extraction output
directory:

- Symlinks whose resolved target stays **inside** the install directory are
  kept. Linux releases legitimately ship relative links between game files.
- Symlinks whose resolved target **escapes** the install directory are unlinked
  ("quarantined by removal"), logged, and the step fails with an actionable
  error naming the removed links. The install is therefore never left with a
  dangerous link even when the step is reported as failed.
- Dangling links are resolved lexically (`parent + target`, `.`/`..` collapsed)
  so a link cannot escape merely because its target does not exist yet.
- Symlinked directories are never traversed by the sweep
  (`follow_links(false)`), so a link cannot hide escaping links behind it.

## Implementation

- `desktop/src-tauri/process/src/path_guard.rs`
  - `remove_escaping_symlinks(root, scan_dir)` canonicalizes the install
    directory, refuses a scan directory outside it, walks it without following
    links, and unlinks escaping links. Returns the removed paths.
  - `symlink_escapes` uses `fs::canonicalize` for resolvable targets and falls
    back to `lexical_normalize(parent.join(target))` for dangling ones.
- `desktop/src-tauri/process/src/pipeline.rs`
  - `sweep_extraction_symlinks(install_dir, output_dir)` wraps the path guard
    helper, logs removed links and turns a non-empty result into a failed step.
  - Called after `extract_rar`, `extract_iso`, `extract_archive` and
    `innoextract`.

## Out of scope / back-compat

- `path_guard` continues to reject symlinked components for every path Drop
  writes itself; the sweep is specifically the post-extractor safety net.
- `run_command` steps are recipe-authored and their program is resolved inside
  the install directory by `resolve_command_program`; symlinks they create
  themselves are not swept.
- The crack overlay copies regular files only (`overlay_directory` skips
  symlinks), so it never propagates an escaping link.
- On Windows, creating symlinks normally requires elevation, so archives
  usually materialize links as regular files there; the sweep is still run and
  is a no-op when no links exist.

## Tests

`desktop/src-tauri/process/src/path_guard.rs` covers escaping links, dangling
escaping links, escaping link chains, internal links being kept, and scan
directories outside the root. `pipeline.rs` covers the step wrapper failing and
removing an escape, keeping internal links, and accepting clean directories.
