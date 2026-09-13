# AGENTS.md — Drop contributor & AI agent guide

**Drop** is an open-source, self-hosted game distribution and multiplayer
platform maintained by [Heretek Games](https://github.com/Heretek-Games/drop)
(transitioned from `Drop-OSS/drop` and `Heretek-AI/drop`).

This is the **canonical** guide for AI agents (opencode, Claude Code, Antigravity,
Gemini CLI) and human developers. `CLAUDE.md` and `GEMINI.md` are thin,
tool-specific wrappers that point back here — update this file first.

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

### 2.7 drop-gse — GSE engine & launch lifecycle (Part A)

Sources: `desktop/src-tauri/gse-engine/`, `process/src/gse_interceptor.rs`,
`process/src/zerotier.rs`, `src/remote.rs`, `desktop/main/gse-contract.ts`.

- **`gse-engine`** (Rust crate): `scanner` (target discovery), `anticheat`
  (fail-closed EAC/BattleEye gate), `dll` (SHA-256 manifest backup/restore),
  `interfaces` (`steam_interfaces.txt`), `config` (per-flavor `steam_settings/`),
  `dist` (release verify/stage + transport-agnostic `fetch_release`), `patch`
  (`PatchPlan` executor). `cargo test -p gse-engine` is self-contained.
- `GseLaunchInterceptor` is **opt-in per launch**: it activates only when
  `steam_settings/custom_broadcasts.txt` exists (written by
  `gse_write_room_config`) or `DROP_GSE_ENABLE` is set, so ordinary launches are
  untouched. It reads the room flavor from
  `steam_settings/drop_gse_flavor.txt` and applies a staged payload from
  `<dataDir>/tools/gse/<flavor>/` (populated by `gse_fetch_release`) and
  restores originals on exit; `recover_interrupted_sessions` repairs stale
  backups at startup. `gse_fetch_release` only trusts HTTPS manifest origins
  named in `DROP_GSE_RELEASE_ALLOWLIST` (loopback excepted), so a manifest and
  its payloads cannot both be attacker-chosen.
- `gse_write_room_config` writes peer addresses and pins the Steam AppID to
  `steam_appid.txt`; the client derives it from `metadataSource === "Steam"` /
  `metadataId`. A compatibility registry (`GSE_BLOCKED_APP_IDS`,
  `GSE_BLOCKED_GAME_IDS`) rejects known-incompatible titles at room creation, and
  the modal requires consent before patching.
- **A↔B contract**: `ActiveRoom` / `PeerSource` (`desktop/main/gse-contract.ts`,
  `process/src/peer_source.rs`). Track B supplies `peers`; empty peers = LAN /
  offline mode.

### 2.8 drop-gse — mesh coordination (Part B)

Sources: `server/server/internal/plugins/builtin/drop-gse.ts`, `builtin/gse/`.

- `drop-gse` is a builtin plugin registering room routes (create / join / leave /
  heartbeat / member / credential, `GET /compat`), events, and WebSocket
  handlers (`gse:credential`, `gse:heartbeat`).
- `RoomStore` (`gse/room-store.ts`) is persistence-agnostic over
  `RoomPersistence`: `PrismaRoomPersistence` (Postgres; `GseRoom` /
  `GseCredential` + migration `20260914000000_add_gse_rooms`) in production and
  `StorageRoomPersistence` (plugin storage) in tests/dev. It enforces host leases
  (15s heartbeat / 45s expiry, first-writer-wins), TTL sweeps and caps.
- `MeshBackend` (`gse/mesh.ts`, `gse/ztnet.ts`) is pluggable; `resolveBackend()`
  in `drop-gse.ts` selects:
  - **`ZtnetBackend` (default)** — ZTNET org REST API (`x-ztnet-auth`): create +
    configure a per-room `/24`, authorize members (deterministic address),
    revoke, delete.
  - `ZeroTierBackend` — raw self-hosted controller (advanced fallback).
  - `TailscaleBackend` + `TailscaleApiProvisioner` — one-off ephemeral keys.
  - `InMemoryMeshBackend` — tests/dev.
- Credentials are membership-gated, rotate 10 min before expiry, and are
  delivered only over the authenticated WebSocket (`plugin_request_ws`) or REST;
  public broadcasts carry no secret. Clients join the network via
  `gse_mesh_join` / `gse_mesh_leave` (`zerotier-cli`).
- Local controller: `server/deploy-template/compose.ztnet.yaml` (zerotier +
  ztnet + postgres) with `.env.ztnet.example`; bootstrap via
  `server/dev-tools/ztnet-bootstrap.mjs`. CI: `.github/workflows/ztnet-e2e.yml`.
  Podman Quadlet systemd templates: `server/deploy-template/quadlet/`.

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

---

## 4. Quality gates

| Layer               | When       | What                                                                                      |
| :------------------ | :--------- | :---------------------------------------------------------------------------------------- |
| Editor hooks        | every edit | format-on-edit (advisory)                                                                 |
| lefthook pre-commit | commit     | prettier + eslint --fix (staged), ast-grep scan, gitleaks                                 |
| lefthook pre-push   | push       | server typecheck, `clippy-changed.sh` (Rust), golangci-lint, knip report                  |
| GitHub Actions      | PR/push    | typecheck/lint/clippy, gitleaks history, cargo-audit ×7 crates, cargo-deny, golangci-lint |
| GitHub Actions      | PR/push    | `server-ci` test job; `ztnet-e2e` (GSE mesh, path-filtered, needs Docker)                 |
| GitHub Actions      | weekly     | semgrep deep scan → Code Scanning                                                         |

Hooks are early feedback; **CI is the authority**. If a hook fails, read the
output and fix the root cause. The documented escape hatches exist but must not
be used to hide a failure:

```sh
git commit --no-verify   # skip pre-commit once
git push --no-verify     # skip pre-push once
LEFTHOOK=0 git commit    # same via env var
```

### Rollout status (flip these when clean)

- **knip**: report-only (CI `continue-on-error`, hook `|| true`). Baseline: 117
  unused files / 31 unused exports / 4 unused deps.
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

# drop-gse — engine + integration checks
cargo +nightly test --manifest-path desktop/src-tauri/Cargo.toml -p gse-engine
# Note: both the root package and `server/` are named "drop", so `pnpm
# --filter drop exec` runs in both — run these from `server/` instead.
DATABASE_URL=postgres://drop:drop@localhost:5432/drop \
  (cd server && pnpm exec jiti dev-tools/gse-prisma-check.ts)   # Prisma room store
# ZTNET mesh E2E (needs Docker) — see .github/workflows/ztnet-e2e.yml
(cd server/deploy-template && docker compose -f compose.yml -f compose.ztnet.yaml \
  --env-file .env.ztnet up -d ztnet zerotier ztnet-postgres)
node server/dev-tools/ztnet-bootstrap.mjs    # prints GSE_ZTNET_ORG / GSE_ZTNET_TOKEN
cd server && pnpm exec jiti dev-tools/gse-ztnet-check.ts

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
  server start via `prisma migrate deploy`. The GSE room store adds
  `prisma/models/gse.prisma` (`GseRoom`, `GseCredential`) + migration
  `20260914000000_add_gse_rooms`.
- Do not commit `server/prisma/client/` (generated, gitignored).
- **ZTNET mesh stack (optional)**: `server/deploy-template/compose.ztnet.yaml`
  is an override for the default compose file and is not started by default.
  `postgres:alpine` is now v18 and rejects a `/var/lib/postgresql/data` mount, so
  the overlay pins `postgres:15-alpine`; it also sets `ZT_ADDR` (ZTNET reports a
  null controller otherwise). ZTNET's first user is the admin; org/API-token
  creation is tRPC-only, scripted for dev by `dev-tools/ztnet-bootstrap.mjs`.
  Ports `3001` (UI) and `9993/udp` can clash with a host ZeroTier install.

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
