# Upstream PR 1 — Platform & Stability Cleanups

**Target:** `Drop-OSS/drop`
**Source:** `Heretek-Games/drop` (`upstream/pr1-platform-stability`)
**Goal:** land general-purpose platform fixes with zero Heretek-domain content,
so upstream can merge them independently of the plugin ecosystem.

## Scope

### Security & correctness (fork review #4)

- `process/src/pipeline.rs`: canonicalize extraction destinations and reject
  symlinked path components (symlink traversal escape).
- `torrential/src/server/mod.rs`: replace the `WaitMap` leak with a removable
  response map evicted on consume/timeout.
- `torrential/src/server/mod.rs`: authenticate the local RPC peer with a
  spawn-time shared secret (`TORRENTIAL_RPC_SECRET`, fail-closed).
- `server/server/api/v1/plugins/ws.get.ts`: enforce message-level and channel
  authorization; reject cross-site upgrades.

### Runtime & packaging

- Docker Quadlet templates and database migration drift fixes.
- Linux platform reach: Proton/UMU runner management, `GAMEID` injection,
  Fedora/CachyOS compatibility.
- S3/MinIO object-storage backend for the depot pipeline.
- Client launch diagnostics and per-game launch-handler override (#59).

### Quality

- Sonar/ESLint security fixes, `droplet` BOM-preservation test (#58), setup
  installer chaining (#55), native HTML games (#57).

## Out of scope

- Emulation, mesh VPN, store scrapers, payments, federation (plugin streams).
- Generic plugin SPI (see PR 2).

## Verification

```sh
pnpm --filter drop run test
pnpm --filter drop run typecheck
cargo +nightly test -p process -p droplet-rs
cd torrential && cargo +nightly test
```
