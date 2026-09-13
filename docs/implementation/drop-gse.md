# drop-gse implementation plan (tracked board)

> Status: active. GitHub Issues are disabled on this repository, so this file is
> the tracked board. If issues are enabled later, each milestone below becomes
> one issue verbatim.
>
> Context: upstream Drop has **no official plugin system**; building one is part
> of this effort. `Heretek-Games/drop-gse` is an **unfinished prototype**
> (`gse-engine/src/dll.rs` and `anticheat.rs` are the only hardened slices); its
> `docs/architecture/SPECIFICATION.md` is aspirational, not a contract.

## Objective

Build an official, first-party extension platform for Drop and deliver
multiplayer as its first plugin family, split into two independently shippable
tracks:

- **Part A — GSE for games:** emulator scanning, patching, config, anti-cheat,
  restore. Ships **without** mesh (offline/LAN mode).
- **Part B — LAN emulation:** per-room mesh (ZeroTier / Tailscale), credentials,
  room and host lifecycle.
- **Track P — Plugin platform:** the foundation both parts are packaged as
  optional plugins on.

## Decisions (confirmed)

1. Platform lives in this Drop repo; `drop-gse` becomes a first-party plugin
   bundle. Only `gse-engine` is carried forward as a starting crate.
2. The prototype addon/client scaffolds are re-implemented, not depended on.
3. Desktop is a **compile-time first-party privileged extension** (Cargo feature
   - runtime opt-in); the server plugin is genuinely optional. The platform must
     define this privileged tier explicitly (M4 / P6).
4. Server ships as an external plugin bundle; durable rooms use additive Prisma
   models.
5. Mesh backend order: **ZeroTier self-hosted controller first**, Tailscale
   second.
6. License review required: GPL-3.0-or-later (drop-gse) + LGPL-3.0 (emulator
   binaries) combined into AGPL-3.0-or-later (Drop).

## Plugin platform contract (M0)

- **API version** — `PLUGIN_API_VERSION` (`server/internal/plugins/types.ts`).
  Plugins declare `metadata.apiVersion`; a mismatch is rejected at registration
  with `PluginApiVersionError`. Manifest files should always set it.
- **Capabilities** — `routes`, `storage`, `events`, `network` are enforced
  fail-closed: using an undeclared capability throws `PluginCapabilityError`
  (routes/events are checked at call time; storage is a guarded wrapper; network
  gates `ctx.fetch`). `websocket` is reserved until a plugin WS API exists.
- **Trust** — only `trust: "trusted"` is supported: external plugins run
  in-process with server privileges. `trust: "sandboxed"` is rejected with
  `PluginTrustError` until an isolated runtime exists (M4/P6). Treat third-party
  plugins as trusted code for now.
- **Storage** — per-plugin directory under `<dataDir>/plugins/<id>/` (writes
  never touch the code dir). `metadata.storageVersion` + `ServerPlugin.migrateStorage`
  drive forward migrations; the recorded version lives in `schema.json`.

## Frozen A↔B contract

Track B produces an `ActiveRoom`; Track A consumes `peers` as the contents of
`custom_broadcasts.txt`. Empty `peers` is valid and means LAN/offline mode.

- TypeScript: `desktop/main/gse-contract.ts` (`ActiveRoom`, `PeerSource`,
  `roomToActiveRoom`).
- Rust: `desktop/src-tauri/process/src/peer_source.rs` (`ActiveRoom`,
  `PeerSource`, `MeshBackend`).

---

## M0 — Plugin platform MVP + test harness (foundation)

Owner: TBD · Depends on: none · Blocks: M1–M5

- [x] **P1** Versioned plugin contract (`PLUGIN_API_VERSION`, manifest schema,
      deprecation policy)
- [x] **P2** Real capability enforcement for `routes` / `storage` / `events` /
      `network` (fail-closed; `websocket` reserved until the ws plugin API lands)
- [x] **P3** Trust/isolation model documented (`trust: "trusted"` only; in-process)
- [x] **P4** Namespaced storage with schema-version migrations; state outside the
      code dir
- [x] **P8** Test harness — plugin tests run without a Nuxt runtime (`server/dev-tools/run-tests.mjs`,
      `pnpm --filter drop run test`)
- [x] Fix `remote.rs::plugin_request` PATCH branch
- [x] Freeze A↔B contract

**Acceptance:** plugin tests green in CI; capability violations fail closed and
are tested; enable/disable/reload without core changes; contract typed on both
sides.

## M1 — Part A: GSE engine (offline/LAN) + reference plugin

Owner: TBD · Depends on: M0

- [x] **A1** Scanner for `steam_api*.dll` / `libsteam_api.so` / `steamclient*.dll`
      (depth-limited, prefix-aware) — `gse-engine/src/scanner.rs`
- [x] **A2** Replaced `process/src/gse_interceptor.rs` backup/restore + anti-cheat
      with the tested `gse-engine` crate
- [x] **A3** Interface extractor → `steam_interfaces.txt` (`interfaces.rs`)
- [x] **A4** Patcher/replacer + digest verify + rollback (`patch.rs`/`dll.rs`)
- [x] **A5** Per-flavor config generation (`config.rs`)
- [x] **A6** Emulator release manager: release.json + SHA-256 verify/stage (`dist.rs`).
      Runtime HTTP fetch still to be wired to a cache directory.
- [ ] **P5/P7/P9** Bundle format + install/update UI + a second trivial plugin to
      prove generality

**Acceptance:** engine patches/configures/restores a real game offline on
Windows and Linux; idempotent; interrupted runs recover; digest mismatch refuses
to deploy.

## M2 — Part A: opt-in launch interceptor + consent/compat

Owner: TBD · Depends on: M1

- [x] **A7** Engine-backed interceptor that runs **only when a room is active or
      `DROP_GSE_ENABLE` is set** (opt-in per launch); ordinary launches no longer
      hit anti-cheat gating or install mutation
- [x] **A8** Crash-recovery startup sweep: restore stale `.orig` backups for all
      installed dirs at client startup (`recover_interrupted_sessions`)
- [ ] **A9** AppID pinning + Proton prefix resolution via installed-version records
- [ ] **A10** Server compatibility DB + user consent UI

**Acceptance:** non-opted games launch byte-identically; anti-cheat titles
blocked only when opted in; kill mid-patch restores on next startup.

## M3 — Part B: mesh backend #1 + real multiplayer session

Owner: TBD · Depends on: M0, M2

- [x] **B1** `MeshBackend` + `InMemoryMeshBackend` (`builtin/gse/mesh.ts`)
- [x] **B2** Durable rooms/memberships/credentials via plugin storage +
      host lease (heartbeat 15s / expiry 45s, first-writer-wins migration) in
      `builtin/gse/room-store.ts`. **Deviation:** used plugin storage instead of
      additive Prisma models (no core migration; still durable on disk).
- [~] **B3** Membership-gated credential issuance, cached per member, never in
  the public room view (`room-store.credential`). Rotation and WS push of
  credentials still pending.
- [~] **B4** `ZeroTierBackend` creates a network via the controller API with a
  per-room /24 and `enableBroadcast` (tested with a mock fetch). Member
  authorization, revoke and network teardown are stubs.
- [ ] **B6** Client mesh join/leave + `vpn.ts` validators; peers → engine
- [x] **B7** TTL sweeper (60s, unref'd), per-host + global caps, auth on room
      reads (member view vs discovery), credential/join/heartbeat auth

**Acceptance:** two machines on different networks play together; coordinator
restart preserves rooms; host migration works; teardown leaves nothing behind.

## M4 — Part B: mesh backend #2 + desktop extension ABI

Owner: TBD · Depends on: M3

- [ ] **B5** Backend #2: Tailscale ephemeral — transactional tag/ACL before keys,
      one-off per-member keys, isolated `--state=mem:`
- [ ] **B8** UI: host/join/leave/teardown + live WebSocket updates
- [ ] **P6** Desktop extension ABI decision + implementation (privileged tier)
- [ ] Client-side WS consumption of `gse:rooms`

**Acceptance:** both backends selectable; documented/enforced plugin tiering.

## M5 — Distribution, packaging & release

Owner: TBD · Depends on: M0–M4

- [ ] Bundle format + `drop-plugin.json` schema finalized
- [ ] Install/update/remove with checksum + signature verification
- [ ] Registry/version pinning; UI hidden unless server advertises capability
- [ ] Docs: admin install guide, `AGENTS.md` plugin section
- [ ] License review + corresponding-source obligations

**Acceptance:** fresh Drop + bundle → host/join/launch with no server rebuild;
removing the plugin leaves no dangling routes/data/backups.

---

## M0 — current increment (this change)

Delivered in the working tree:

- `PluginManager` is now dependency-injectable (`dataDir`, `storageFactory`,
  `authResolver`) and imports Drop's runtime config / ACL manager / file storage
  **lazily**, so the module can be imported outside Nuxt.
- `server/dev-tools/run-tests.mjs` discovers and runs `*.test.ts` through jiti
  with the `~` alias; wired as `pnpm --filter drop run test`.
- `plugins.test.ts` injects in-memory storage + a stub auth resolver; all 6 tests
  pass (pipeline tests: 7 pass).
- `remote.rs::plugin_request` now forwards `PATCH` (Settings → Plugins toggle).
- A↔B contract frozen on both sides and consumed by
  `useGseMultiplayer.syncRoomConfigToDisk`.
- Removed the undeclared `uuid` dependency in `drop-gse.ts` (`node:crypto`
  `randomUUID`); declared `jiti` for the server test script.
- P1–P4: `PLUGIN_API_VERSION` + `apiVersion`/`trust`/`storageVersion` manifest
  fields; fail-closed capabilities (`PluginCapabilityError`), guarded storage,
  `ctx.fetch`; storage schema migrations; version/trust validation. Tests cover
  each (10 plugin tests + 7 pipeline tests pass).

M0 complete. **M1 engine (A1–A6) landed** as the `desktop/src-tauri/gse-engine`
crate (18 unit tests pass) and the `process` interceptor now delegates to it.
Remaining in M1: P5/P7/P9 packaging, and wiring a real emulator payload.

M2 A7/A8 landed: the interceptor is opt-in (room config or `DROP_GSE_ENABLE`)
and the client restores interrupted sessions on startup. Remaining: A9/A10 and
the in-app consent toggle.

Next: A9/A10, then M3 (Part B mesh backend).
