# AGENTS.md — Drop contributor & AI agent guide

**Drop** is an open-source, self-hosted game distribution and multiplayer
platform maintained by [Heretek Games](https://github.com/Heretek-Games/drop)
(transitioned from `Drop-OSS/drop` and `Heretek-AI/drop`).

This is the **canonical** guide for AI agents (opencode, Claude Code, Antigravity,
Gemini CLI) and human developers working on **`drop` core**. `CLAUDE.md` and `GEMINI.md` are thin,
tool-specific wrappers that point back here — update this file first.

> [!NOTE]
> **Multi-Repo Workspace**: `drop` is the core platform within the [Heretek Games](https://github.com/Heretek-Games) workspace (`~/Projects/Heretek-Games/`).
> Specialized subsystems live in dedicated sister repositories to keep `drop` lean and upstream-friendly with `Drop-OSS/drop`:
>
> - **GSE Multiplayer Engine**: [`drop-gse`](https://github.com/Heretek-Games/drop-gse) (`~/Projects/Heretek-Games/drop-gse`)
> - **ZeroTier Mesh Provider**: [`drop-zerotier`](https://github.com/Heretek-Games/drop-zerotier) (`~/Projects/Heretek-Games/drop-zerotier`)
> - **Plugin SDK & CLI**: [`drop-plugin-sdk`](https://github.com/Heretek-Games/drop-plugin-sdk) (`~/Projects/Heretek-Games/drop-plugin-sdk`)
> - **GameBox Metadata Index**: [`drop-gamebox`](https://github.com/Heretek-Games/drop-gamebox) (`~/Projects/Heretek-Games/drop-gamebox`)
> - **Seedbox / qBittorrent**: [`drop-seedbox`](https://github.com/Heretek-Games/drop-seedbox) (`~/Projects/Heretek-Games/drop-seedbox`)
> - **Federation & Peering**: [`drop-federation`](https://github.com/Heretek-Games/drop-federation) (`~/Projects/Heretek-Games/drop-federation`)
>
> Core `drop` changes should focus on general improvements, upstream compatibility, and the generic Plugin SPI.

---

## 1. Monorepo layout

| Directory                | Stack                                                             | Description                                                                                                                |
| :----------------------- | :---------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| **`server/`**            | Nuxt 3, Nitro, Vue 3, TypeScript, Prisma 7.10, Tailwind, Protobuf | Web app, REST API, WebSocket pub/sub, library manager, plugin SPI, Game Distribution pipeline.                             |
| **`backend/`**           | Go (`backend/go.work`, module `core/`)                            | Background game management and sync services.                                                                              |
| **`desktop/`**           | Tauri v2 (`drop-app`), Node build scripts                         | Desktop client orchestration and packaging.                                                                                |
| **`desktop/main/`**      | Nuxt 4 (`view`)                                                   | Desktop client UI. **Separate pnpm workspace** (own `pnpm-workspace.yaml`).                                                |
| **`desktop/src-tauri/`** | Rust (cargo workspace)                                            | Tauri commands, process manager, launch interceptors, native pipeline runner. `Cargo.lock` is committed.                   |
| **`cli/`**               | Rust                                                              | `downpour` CLI for interacting with Drop instances.                                                                        |
| **`torrential/`**        | Rust (standalone cargo workspace)                                 | Depot HTTP server that serves chunks from library backends; spawned by the server.                                         |
| **`libraries/`**         | Rust & TypeScript                                                 | `droplet` (manifest gen + read backends), `droplet_types`, `libarchive`, `native_model`; TS UI layer in `libraries/base/`. |
| **`distribution/`**      | YAML / XML / Desktop                                              | Packaging manifests: WinGet (`winget/`), Flatpak (`flatpak/`).                                                             |
| **`sites/`**             | Astro / site tooling                                              | `sites/docs` (`docs-next`), `sites/promo` (`radiant`).                                                                     |
| **`scripts/`**           | Shell                                                             | `clippy-changed.sh` (pre-push Rust lint), helpers.                                                                         |

pnpm workspace roots: root (`package.json`) covers `server/`,
`libraries/base/`, `sites/*`, and `desktop/`. **`desktop/main/` is NOT part of
the root workspace** — use `pnpm -C desktop/main ...`.

---

## 2. Key architectural systems

### 2.1 Game Distribution Pipeline & declarative recipes (server)

Source: `server/server/internal/library/pipeline/`

- **`classifier.ts`** — detects `DistributionType`: `SceneRelease`, `GogInstaller`,
  `FitGirlRepack`, `KaOsRepack`, `DodiRepack`, `ArchiveBundle`, `LoosePortable`,
  `PatchUpdate`, `Unknown`.
- **`executable-scorer.ts`** — ranks candidate game binaries, filtering crash
  handlers, redistributables, uninstallers and verifiers.
- **`recipe-generator.ts`** — emits a declarative `PipelineRecipe` of
  `PipelineStep`s (`extract_rar`, `extract_iso`, `extract_archive`,
  `innoextract`, `apply_crack`, `cleanup`, `run_command`) plus standalone
  `drop-pipeline-setup.bat` / `.sh` fallbacks.
- `library/index.ts` `importVersion()` embeds the recipe at
  `GameVersion.dropletManifest.recipe` and auto-adds a setup command when a
  release needs one. The desktop client executes the recipe natively.
- Param names matter and are consumed by the Rust runner: `extract_rar` uses
  `input`, `extract_archive` uses `archiveFile`, `extract_iso` uses
  `sourceGlob`. Keep server and `process/src/pipeline.rs` in sync.
- Standalone Scene ISOs emit only `extract_iso` (no redundant `extract_rar`).

### 2.2 Desktop native pipeline runner (Track 1)

Source: `desktop/src-tauri/process/src/pipeline.rs`,
`desktop/src-tauri/src/process.rs`, `desktop/main/components/GameSetupModal.vue`

- `prepare_pipeline(game_id)` resolves the recipe + install dir synchronously so
  IPC can validate before spawning; `run_prepared_pipeline` executes it.
- Emits `pipeline_progress` and `pipeline_completed` Tauri events; IPC commands
  are `start_pipeline_setup`, `cancel_pipeline_setup`, `reclaim_pipeline_space`.
- `GameSetupModal.vue` shows step progress, a live log, cancellation and
  post-setup archive reclamation. The library page falls back to the legacy
  setup command when a version has no recipe; generated setup scripts are
  materialized from the recipe before running, and a missing script reports an
  actionable error instead of spawning a nonexistent file.
- Tools (`7z`, `innoextract`) are discovered on PATH / bundled
  `<data>/tools/<tool>/`; missing tools produce an actionable error.

### 2.3 Admin bulk auto-import (Track 2)

- Model `DiscoveredGame` (`server/prisma/models/discovery.prisma`) persists
  scan results and decisions (`Pending` / `Imported` / `Ignored`).
- Task groups `import:discover` (`registry/discover-games.ts`) and `import:bulk`;
  `libraryManager.discoverUnimportedGames()` and
  `importUnimportedVersionsForGame()` do the work. Bulk import filters
  already-imported versions (retries are idempotent) and only marks a discovery
  `Imported` when at least one version was actually imported.
- APIs: `GET/POST/PATCH /api/v1/admin/import/discover`,
  `POST /api/v1/admin/import/bulk`; UI at `pages/admin/import/bulk.vue`.

### 2.4 Depot chunk cache (Track 3)

Source: `torrential/src/downloads/cache.rs` (wired in `serve.rs`, `state.rs`, `main.rs`)

- Opt-in read-through cache keyed by the **SHA-256 plaintext checksum**
  (`ChunkData::checksum`). Disabled unless `CHUNK_CACHE_DIR` is set;
  `CHUNK_CACHE_MAX_BYTES` bounds the LRU (default 20 GiB).
- Caches plaintext (pre-AES) bytes, is best-effort (a cache failure never fails
  a request), uses single-flight fills and atomic `.partial` → rename. Cache
  keys must be 64-char SHA-256 hex; plaintext is hashed during the fill and
  refused unless it matches the key, and in-flight fills are bounded by the
  configured budget.
- Documented optional volume/env in `server/deploy-template/compose.yml` and
  `sites/docs/src/content/docs/admin/quickstart.md`; the cache stores
  **unencrypted game data at rest**.
- The RPC listener (`server/src/server/mod.rs`) authenticates its local peer
  with a spawn-time shared secret: `TORRENTIAL_RPC_SECRET` (64 hex chars) is
  set by the server for the child it spawns and is required by torrential
  (fail-closed). An operator running torrential out-of-process must set the
  same value on both sides. The `WaitMap` leak was replaced by a removable
  response map, and committed + in-flight cache bytes now share one budget.
- `/invalidate` and `/api/v1/depot/manifest.json` accept an optional
  `TORRENTIAL_HTTP_TOKEN` (`Authorization: Bearer <token>` or
  `x-torrential-token`); when unset those routes stay open for back-compat.

### 2.5 Tauri high-DPI window architecture

- Use a single `WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("main".into()))`
  in `desktop/src-tauri/src/lib.rs`.
- **Do NOT** use decoupled child webviews (`WindowBuilder` + `add_child(WebviewBuilder)`);
  they desynchronize physical/logical bounds on Windows 4K at 200–300% scaling.
- Webview label `"main"` must match `desktop/src-tauri/capabilities/default.json`.

### 2.6 Plugin platform (Track P)

Source: `server/server/internal/plugins/`

- `PluginManager` (`manager.ts`) owns the lifecycle: dynamic routing
  `/api/v1/plugins/[pluginId]/...`, an event bus, the WebSocket gateway
  (`api/v1/plugins/ws.get.ts`), and discovery of external bundles from
  `${dataDir}/plugins/*/drop-plugin.json`. It is dependency-injectable
  (`dataDir`, `storageFactory`, `authResolver`, `registryPath`) and resolves
  Drop's runtime config lazily, so it imports outside Nuxt and is unit-testable.
- **Contract**: `PLUGIN_API_VERSION` (`types.ts`); `metadata.apiVersion` is
  required and a missing or mismatched version is rejected
  (`PluginApiVersionError`).
- **Capabilities** are fail-closed (declaring none denies all): `routes`,
  `storage`, `events`, `network`, `websocket`. Undeclared use throws
  `PluginCapabilityError` (routes/events at call time, storage via a guarded
  wrapper, `network` gates `ctx.fetch`, `websocket` gates
  `ctx.registerWebSocket`). `trust: "trusted"` (in-process) is the only tier;
  `"sandboxed"` is rejected until an isolated runtime exists.
- **Auth**: plugin REST routes and the WS gateway resolve browser sessions,
  `Bearer` API tokens, and the desktop client `JWT <clientId> <jwt>` scheme
  (`internal/plugins/auth.ts`). Sensitive WS channels require an authenticated
  peer and cross-site upgrades (Origin mismatch) are rejected.
- **Storage**: one directory per plugin under `<dataDir>/plugins/<id>/`, with
  `metadata.storageVersion` driving `migrateStorage` (recorded in `schema.json`).
- **Bundles**: `<dataDir>/plugins/<id>/{drop-plugin.json,index.js}`. Optional
  `checksum` (SHA-256 of the entry) and `signature` (HMAC-SHA256 under
  `DROP_PLUGIN_SIGNING_KEY`); `DROP_PLUGIN_REQUIRE_SIGNATURE=true` refuses
  unsigned bundles. A `PluginRegistry` (`DROP_PLUGIN_REGISTRY`) allow-lists ids
  and pins version/checksum. Sign with `server/dev-tools/sign-plugin.mjs`.
- Admin install/remove: `POST /api/v1/plugins/install`,
  `DELETE /api/v1/plugins/<id>/bundle`, plus the Settings → Plugins UI
  (`desktop/main/pages/settings/plugins.vue`). Builtins cannot be removed.
- Tests run via `pnpm --filter drop run test` (`server/dev-tools/run-tests.mjs`,
  jiti + `~` alias). `hello-world` is the minimal reference plugin.

### 2.7 Modular plugin architecture & externalized subsystems

Drop core maintains a strictly decoupled, upstream-friendly architecture.
Domain-specific features are implemented as external plugins or standalone
sister repositories:

- **Multiplayer & Emulation (`drop-gse`)**: Goldberg Steam Emulator patching,
  anti-cheat verification, and P2P room lifecycle are externalized in
  [`Heretek-Games/drop-gse`](https://github.com/Heretek-Games/drop-gse).
- **Mesh Networking (`drop-zerotier`)**: ZeroTier / ZTNET room mesh coordination
  and daemon management are externalized in
  [`Heretek-Games/drop-zerotier`](https://github.com/Heretek-Games/drop-zerotier).
- **Plugin SPI & SDK (`drop-plugin-sdk`)**: Type definitions, CLI tooling, and
  runtime test suites for external plugins live in
  [`Heretek-Games/drop-plugin-sdk`](https://github.com/Heretek-Games/drop-plugin-sdk).

Core `drop` exposes generic hook points:

- `LaunchInterceptor` trait (`process/src/interceptor.rs`) for native launch
  lifecycle extension (`pre_launch`, `on_running`, `post_exit`).
- Generic Plugin SPI (`server/server/internal/plugins/`) for backend extensions,
  dynamic REST routes, authenticated WebSocket events, and isolated storage.

### 2.9 Desktop UI conventions

- Vue discriminated unions (`GameStatus`) must be narrowed with a typed
  computed (e.g. `installedData = computed(() => status.value?.type === "Installed" ? status.value : undefined)`)
  before accessing `install_type`.
- `ModalTemplate`/`LoadingButton` live in `libraries/base/` and are auto-imported.
- Plugin settings UI: `desktop/main/pages/settings/plugins.vue`.

---

## 3. Toolchain

| Tool         | Version / requirement                                            |
| :----------- | :--------------------------------------------------------------- |
| **Node.js**  | `>=22.16.0` (server `engines`)                                   |
| **pnpm**     | 10+                                                              |
| **Rust**     | `cargo +nightly` (workspace features: `nonpoison_mutex`, etc.)   |
| **Go**       | 1.26 (`backend/go.work`)                                         |
| **Prisma**   | 7.10.0 (pinned); multi-file schema under `server/prisma/models/` |
| **Lefthook** | 2.x                                                              |

> `desktop/src-tauri/Cargo.toml` sets `[profile.dev.package.tokio] opt-level = 1`
> to avoid an upstream nightly ICE while compiling Tokio in debug.

> Local development: `mise install` provisions the pinned runtimes above plus
> the lint/security tools (see `.mise.toml`).

---

## 4. Quality gates

| Layer               | When       | What                                                                                                                                 |
| :------------------ | :--------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| Editor hooks        | every edit | format-on-edit (advisory)                                                                                                            |
| lefthook pre-commit | commit     | prettier + eslint --fix (staged), ast-grep scan, gitleaks                                                                            |
| lefthook pre-push   | push       | server typecheck, `clippy-changed.sh` (Rust), golangci-lint, knip report                                                             |
| GitHub Actions      | PR/push    | typecheck/lint/clippy, gitleaks history, cargo-audit ×7 crates, cargo-deny, golangci-lint                                            |
| GitHub Actions      | PR/push    | `server-ci` test job; `ztnet-e2e` (GSE mesh, path-filtered, needs Docker)                                                            |
| GitHub Actions      | PR/push    | `analysis` (report-only): actionlint, zizmor, shellcheck, hadolint, pnpm audit, govulncheck, cargo-machete, desktop typecheck + knip |
| GitHub Actions      | weekly     | semgrep deep scan → Code Scanning                                                                                                    |

Hooks are early feedback; **CI is the authority**. If a hook fails, read the
output and fix the root cause. The documented escape hatches exist but must not
be used to hide a failure:

```sh
git commit --no-verify   # skip pre-commit once
git push --no-verify     # skip pre-push once
LEFTHOOK=0 git commit    # same via env var
```

### Rollout status (flip these when clean)

- **knip**: report-only (CI `continue-on-error`, hook `|| true`). Root is now
  clean of unused files/dependencies/unlisted deps; remaining items are runtime
  false positives (unused devDeps, the `./torrential` spawn, `desktop/main`
  contract types) plus unused/duplicate exports. `desktop/main` (separate
  workspace) is analyzed with `desktop/main/knip.json` via
  `pnpm exec knip --directory desktop/main`.
- **analysis**: report-only (every job `continue-on-error`). Promote each job to
  blocking individually once its baseline is triaged.
- **golangci-lint**: `--new-from-rev=origin/develop` (new issues only). Baseline:
  2 legacy issues in `core/database.go`.
- **ast-grep**: rules at `severity: warning`; promote per-rule after cleanup.
- **`torrential` clippy**: `cargo clippy --all-targets --all-features -- -D warnings`
  is clean. Generated rust-protobuf output is built into `OUT_DIR` by `build.rs`
  and included through `src/proto/mod.rs`, which applies
  `#[allow(clippy::all, clippy::pedantic)]`, so generated code never trips the
  crate lints. `torrential-ci.yml` runs fmt + clippy + build + test.
- **Desktop frontend typecheck**: `desktop/main` is not a root workspace member
  and is not gated; `pnpm -C desktop/main run typecheck` currently reports
  pre-existing errors. Don't introduce new ones.

---

## 5. Essential commands

```sh
# Install / generate
pnpm install                                # root workspace deps + Prisma client
cd server && pnpm exec prisma generate      # after schema changes

# Server
pnpm --filter drop run typecheck
pnpm --filter drop run lint
pnpm --filter drop run test
#   ^ runs every server `*.test.ts` through `server/dev-tools/run-tests.mjs`
#     (jiti + the `~` alias). Plain `node --test` fails on the ESM/alias setup.

# Desktop frontend (separate workspace; not gated)
pnpm -C desktop/main install
pnpm -C desktop/main run typecheck

# Rust — desktop client (needs Tauri system libs)
cargo +nightly check --manifest-path desktop/src-tauri/Cargo.toml -p process
cargo +nightly check --manifest-path desktop/src-tauri/Cargo.toml -p drop-app
cargo +nightly check --manifest-path desktop/src-tauri/Cargo.toml --tests -p process

# Rust — torrential (standalone workspace; needs libarchive-devel)
cd torrential && cargo +nightly build --all-targets && cargo +nightly test

# Go
cd backend && golangci-lint run --new-from-rev=origin/develop ./core/...

# Hooks / structural lint
pnpm exec lefthook run pre-commit --all-files
pnpm exec lefthook run pre-push --all-files
pnpm exec ast-grep scan [paths]
pnpm exec knip --reporter compact
```

Native binaries not installable via pnpm:

- `gitleaks` — `brew install gitleaks`
- `cargo-audit` — `cargo install cargo-audit`
- `cargo-deny` — `cargo install cargo-deny` (policy config at `deny.toml`;
  run from a crate dir, e.g. `cd torrential && cargo deny check`)
- `golangci-lint` — `go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest`
  (must be built with the same Go version as `backend/go.work`)
- `libarchive-devel` — required to build `torrential` (Fedora) / `libarchive-dev` (Debian)

---

## 6. Environment quirks

- **`cargo` may not be on `PATH`** for git hooks / non-login shells; rustup lives
  at `~/.cargo/bin`. Export it before cargo/hook commands if needed.
- **Headless desktop `cargo check`**: `desktop/src-tauri` links GTK/WebKit.
  On a box without the real dev libs, `pkg-config` shims under
  `~/.local/lib/pkgconfig` plus `PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig"`
  allow `cargo check` (type-check only). **`cargo test` for desktop still needs
  real GTK/WebKit `.so` files to link**, so prefer `cargo check --tests`.
- **`libdbus-sys`** is a Linux-only target dependency (vendored) in
  `database/Cargo.toml`; it lets `keyring` build without system `dbus-1.pc`.
  Do not make it unconditional — it doesn't build on Windows/macOS.
- **Prisma multi-file schema**: `prisma.config.ts` sets the schema to the
  `prisma/` folder; models live in `prisma/models/*.prisma`. Add a migration
  under `prisma/migrations/<timestamp>_<name>/migration.sql`; it applies on next
  server start via `prisma migrate deploy`.
- Do not commit `server/prisma/client/` (generated, gitignored).

---

## 7. Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(desktop): ...`, `fix(server): ...`). One logical change per commit.
- **Rust**: nightly toolchain; keep clippy clean for touched crates where the
  baseline allows. Prefer `unwrap_or_else`/explicit errors over `unwrap`/`expect`
  in new code (`unwrap_used`/`expect_used` are warn-level lints).
- **Formatting**: Prettier config at the repo root (JS/TS/Vue/YAML/MD); `gofmt`/
  `goimports` for Go.
- **Go**: keep modules inside `backend/` consistent with `go.work`.
- **Secrets**: never commit tokens/keys. Use `.gitleaksignore` fingerprints only
  for historical mock fixtures.
- **Blame hygiene**: record formatting-only passes in `.git-blame-ignore-revs`.

## 8. Keeping the board green

**Toolchain** — `mise install` (`.mise.toml`) pins node/pnpm/python/go/rust plus
`shellcheck`, `shfmt`, `hadolint`, `actionlint`, `ruff`, `gitleaks` and `typos`.
Git hooks resolve tools through `scripts/run-tool.sh`, which fails with an
actionable install hint instead of silently skipping a check.

**Git hooks** (`lefthook.yml`, installed by `pnpm install`):

- pre-commit: prettier, server eslint, ast-grep, shellcheck, hadolint,
  actionlint, ruff (check + format), typos and gitleaks.
- commit-msg: commitlint (Conventional Commits).
- pre-push: server typecheck + lint, per-workspace frontend lint, cargo fmt +
  clippy on changed crates, golangci-lint, report-only knip and an optional
  local `sonar analyze --base origin/develop` (skipped without
  `~/.config/sonar/env`).

**Lint rules** — `eslint.config.shared.mjs` holds the curated local equivalents
of the SonarCloud rules (sonarjs, regexp, unicorn, vuejs-accessibility) for
every workspace; `server/ruff.toml` covers Python under `server/dev-tools`.

**SonarCloud** — project `Heretek-Games_drop`, automatic analysis on push; the
gate enforces the last 30 days of new code. `server/prisma/migrations/**` and
vendored `libraries/{libarchive,native_model}/**/Cargo.toml` are excluded.
Triage policy: fix the root cause, else a justified `NOSONAR` on the exact line,
else accept with a rationale comment via the API. `knip` stays report-only until
its unused/duplicate exports are triaged.

**Agents** — opencode formats edited files via `.opencode/plugin/quality.js`
and documents the workflows in `.opencode/skills/`; Claude Code uses the
PostToolUse hook in `.claude/settings.json`; Cursor and Codex get Sonar secrets
scanning plus the SonarQube MCP server (`.mcp.json`, `.cursor/mcp.json`,
`.codex/config.toml`). The shared per-file formatter is
`scripts/agent-quality.sh`. Restart opencode after config changes.

<!-- sonar:begin:codex-secrets-on-read -->

# SonarQube secrets scanning for files protocol

Before reading any file in this workspace, when the deterministic scanner is
available (`command -v sonar`), scan it for secrets:

```bash
sonar analyze secrets <path/to/file>
```

If the `sonar` CLI is not installed, skip this step; the git hooks and CI still
run gitleaks. If the command reports that the file contains a secret, **do not
read the file**. Instead:

1. Inform the user that the file appears to contain a secret or credential and that reading it would expose the value in chat history, logs, and any downstream telemetry.
2. Advise them to rotate the leaked credential at its source of truth and remove it from the file.
3. Do not proceed with the original request until the secret has been removed.

<!-- sonar:end:codex-secrets-on-read -->
