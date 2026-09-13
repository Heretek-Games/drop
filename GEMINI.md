# Drop — Gemini / Antigravity guide

**Drop** is an open-source, self-hosted game distribution and multiplayer
platform maintained by [Heretek Games](https://github.com/Heretek-Games/drop).

> **Canonical guide: read [`AGENTS.md`](./AGENTS.md)** — it is the source of
> truth for the monorepo layout, architecture, quality gates, toolchain,
> commands, environment quirks and conventions. This file is a thin wrapper for
> Gemini CLI / Google Antigravity sessions; update `AGENTS.md` first and keep
> this in sync.

## Orientation

Polyglot monorepo:

- `server/` — Nuxt 3 + Vue 3 (TypeScript, Prisma 7.10, Tailwind, buf/protobuf):
  REST API, WebSocket pub/sub, library manager, plugin SPI, Game Distribution
  pipeline & declarative recipes.
- `backend/` — Go (`go.work`, module `core/`).
- `desktop/src-tauri/` — Rust cargo workspace: Tauri commands, process manager,
  launch interceptors, native pipeline runner (`process/src/pipeline.rs`).
- `desktop/main/` — Nuxt 4 `view` UI (separate pnpm workspace).
- `torrential/` — standalone Rust depot/chunk HTTP server (with the opt-in
  content-addressed chunk cache).
- `cli/` — Rust `downpour`; `libraries/` — `droplet`, `droplet_types`,
  `libarchive`, `native_model`, plus the `base/` TS UI layer.
- `distribution/` (WinGet/Flatpak), `sites/` (docs, promo).

## Systems to be aware of

See `AGENTS.md` §2 for detail. Highlights relevant to recent work:

- **Game Distribution pipeline & recipes** — `server/server/internal/library/pipeline/`
  classifies releases and emits `PipelineRecipe`s embedded at
  `GameVersion.dropletManifest.recipe`.
- **Desktop native pipeline runner** — `process/src/pipeline.rs` +
  `GameSetupModal.vue`; emits `pipeline_progress` / `pipeline_completed`,
  IPC `start_pipeline_setup` / `cancel_pipeline_setup` / `reclaim_pipeline_space`.
- **Admin bulk auto-import** — `DiscoveredGame` model, `import:discover` /
  `import:bulk` tasks, `pages/admin/import/bulk.vue`.
- **Depot chunk cache** — `torrential/src/downloads/cache.rs`, opt-in via
  `CHUNK_CACHE_DIR` / `CHUNK_CACHE_MAX_BYTES`.

## Working notes for Gemini / Antigravity

- **Follow `AGENTS.md` for commands and gates.** Prefer `cargo +nightly`,
  `pnpm --filter drop run typecheck`, and `jiti` for server `node:test` files
  (no test runner is wired).
- **Never bypass hooks to hide a failure.** `git push --no-verify` is documented
  only for the known `torrential` clippy baseline (generated `src/proto/version.rs`
  - `build.rs`); torrential CI intentionally does not run clippy.
- **`desktop/main` is a separate pnpm workspace** — use `pnpm -C desktop/main ...`.
- **Headless desktop checks**: `cargo check` needs GTK/WebKit pkg-config shims
  (`PKG_CONFIG_PATH="$HOME/.local/lib/pkgconfig"`); `cargo test` for the desktop
  crate still requires real GTK/WebKit libraries to link.
- **Prisma**: multi-file schema under `server/prisma/models/`; add migrations
  under `server/prisma/migrations/<timestamp>_<name>/migration.sql`; run
  `pnpm exec prisma generate` after schema changes.
- **Commits**: Conventional Commits, one logical change per commit.
