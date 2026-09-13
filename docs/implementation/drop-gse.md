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
- **Capabilities** — `routes`, `storage`, `events`, `network`, `websocket` are
  enforced fail-closed: using an undeclared capability throws
  `PluginCapabilityError` (routes/events are checked at call time; storage is a
  guarded wrapper; network gates `ctx.fetch`; websocket gates
  `ctx.registerWebSocket`, whose handlers the `/api/v1/plugins/ws` gateway
  dispatches to via `PluginManager.dispatchWebSocket`).
- **Trust** — only `trust: "trusted"` is supported: external plugins run
  in-process with server privileges. `trust: "sandboxed"` is rejected with
  `PluginTrustError` until an isolated runtime exists (M4/P6). Treat third-party
  plugins as trusted code for now.
- **Storage** — per-plugin directory under `<dataDir>/plugins/<id>/` (writes
  never touch the code dir). `metadata.storageVersion` + `ServerPlugin.migrateStorage`
  drive forward migrations; the recorded version lives in `schema.json`.
- **Bundle format** — `<dataDir>/plugins/<id>/{drop-plugin.json,index.js}`.
  `drop-plugin.json` declares `id`/`name`/`version`/`apiVersion`/`capabilities`
  plus optional `entry`, `checksum` (SHA-256 of the entry file) and `signature`
  (HMAC-SHA256 of the checksum under `DROP_PLUGIN_SIGNING_KEY`). Verify/sign
  with `node dev-tools/sign-plugin.mjs <bundle-dir>`; see
  `dev-tools/sample-plugin/`. `DROP_PLUGIN_REQUIRE_SIGNATURE=true` refuses
  unsigned bundles.
- **Desktop extension ABI (P6 decision)** — third-party plugins are
  **server-side only** for now. Desktop integration is compiled in behind Cargo
  features + runtime opt-in because GSE needs filesystem and VPN access that
  cannot be safely sandboxed in-process; a WASM/sidecar plugin runtime is a
  future option, not a v1 requirement.

## Frozen A↔B contract

Track B produces an `ActiveRoom`; Track A consumes `peers` as the contents of
`custom_broadcasts.txt`. Empty `peers` is valid and means LAN/offline mode.

- TypeScript: `desktop/main/gse-contract.ts` (`ActiveRoom`, `PeerSource`,
  `roomToActiveRoom`).
- Rust: `desktop/src-tauri/process/src/peer_source.rs` (`ActiveRoom`,
  `PeerSource`, `MeshBackend`).

## Licensing

- **drop-gse** plugin code is GPL-3.0-or-later; Drop is AGPL-3.0-or-later.
  AGPLv3 §13 permits combining with GPLv3, so shipping the plugin with Drop is
  allowed provided the combined distribution offers corresponding source under
  the AGPL and honours the GPL terms.
- **Emulator binaries** (gbe_fork / gse_fork) are LGPL-3.0. They are fetched at
  runtime and never vendored; keep them as dynamically replaced libraries and
  ship their license notices.
- Distributing the plugin bundle counts as distribution: publish the bundle's
  corresponding source plus a third-party NOTICE. The engine's emulator payload
  is not part of the Drop source tree.
- **ReFix is a non-goal** (inconsistent license).
- This is an engineering summary, **not legal advice**; a maintainer legal
  review is required before a stable release.

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
- [x] **A6** Emulator release manager: `release.json` + SHA-256 verify/stage and
      a transport-agnostic `fetch_release` hook (`dist.rs`; 19 engine tests).
      The desktop supplies the reqwest-backed fetch.
- [~] **P5/P7/P9** Bundle integrity: `checksum`/`signature` verified before an
  external bundle is imported (`DROP_PLUGIN_SIGNING_KEY`,
  `DROP_PLUGIN_REQUIRE_SIGNATURE`), tested. P9 done via the `hello-world`
  reference plugin. Install/update/remove UI + registry (P7/P5) pending.

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
- [x] **A9** AppID pinning end-to-end: rooms carry an optional `appId` (derived
      from `metadataSource === "Steam"` / `metadataId`), `gse_write_room_config`
      writes `steam_appid.txt`, and the A↔B contract carries it. Proton launches
      reuse Drop's resolved `install_dir` (no separate prefix logic needed).
- [x] **A10** Server compat registry (`GSE_BLOCKED_APP_IDS` /
      `GSE_BLOCKED_GAME_IDS`, `GET /compat`, room creation rejected with 409) and
      a consent checkbox gating host/join in the GSE modal.

**Acceptance:** non-opted games launch byte-identically; anti-cheat titles
blocked only when opted in; kill mid-patch restores on next startup.

## M3 — Part B: mesh backend #1 + real multiplayer session

Owner: TBD · Depends on: M0, M2

- [x] **B1** `MeshBackend` + `InMemoryMeshBackend` (`builtin/gse/mesh.ts`)
- [x] **B2** Durable rooms/memberships/credentials via plugin storage +
      host lease (heartbeat 15s / expiry 45s, first-writer-wins migration) in
      `builtin/gse/room-store.ts`. **Deviation:** used plugin storage instead of
      additive Prisma models (no core migration; still durable on disk).
- [x] **B3** Membership-gated credential issuance, cached per member, rotated
      10 min before expiry, never in the public room view. A `credential_available`
      event is broadcast on the room channel; the secret itself is only returned
      from the authenticated endpoint.
- [x] **B4** `ZeroTierBackend` creates networks (per-room /24, `enableBroadcast`),
      authorizes a joined member and returns its assigned address, and deletes
      the network on teardown (mock-fetch tests). Per-user revoke still a stub.
- [~] **B6** Client requests its credential after host/join and refreshes the
  room, so assigned mesh addresses reach `custom_broadcasts.txt` via the
  A↔B contract. Client-side VPN status validators still pending.
- [x] **B7** TTL sweeper (60s, unref'd), per-host + global caps, auth on room
      reads (member view vs discovery), credential/join/heartbeat auth

**Acceptance:** two machines on different networks play together; coordinator
restart preserves rooms; host migration works; teardown leaves nothing behind.

## M4 — Part B: mesh backend #2 + desktop extension ABI

Owner: TBD · Depends on: M3

- [~] **B5** `TailscaleBackend` (tag provisioning + one-off ephemeral keys via
  an injected `TailscaleProvisioner`, tested). Wiring the embedded
  `desktop/src-tauri/tailscale` crate with isolated `--state=mem:` pending.
- [x] **B8** UI host/join/leave/teardown plus live updates: `plugin_subscribe`
      opens the plugin WS gateway from Rust and emits `plugin:event`; the modal
      subscribes to `gse:rooms` on open and refreshes on room events. Broadcast
      payloads for the public channel are sanitized with `toDiscoverable`.
- [x] **P6** Desktop extension ABI decision recorded: third-party plugins are
      server-side only; desktop work is a compiled-in first-party privileged
      tier (WASM/sidecar runtime deferred)
- [x] Client-side WS consumption of `gse:rooms` (via the `plugin:event`
      Tauri channel)

**Acceptance:** both backends selectable; documented/enforced plugin tiering.

## M5 — Distribution, packaging & release

Owner: TBD · Depends on: M0–M4

- [x] Bundle format + `drop-plugin.json` schema (see platform contract above)
- [x] Checksum + optional signature verification on load, with the
      `dev-tools/sign-plugin.mjs` signer and a `sample-plugin/` bundle
- [x] Install/update/remove: `PluginManager.installBundle` /
      `removeBundle` with checksum/signature verification and admin routes
      (`POST /api/v1/plugins/install`, `DELETE /api/v1/plugins/<id>/bundle`),
      tested. Registry/version pinning beyond `apiVersion` still pending.
- [x] Docs: admin guide at `sites/docs/src/content/docs/admin/plugins.md`
- [x] License review recorded (see **Licensing** below)

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
