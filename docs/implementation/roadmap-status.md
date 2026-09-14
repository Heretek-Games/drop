# Roadmap Completion Status

Status of the two plans delivered for Heretek-Games/drop. `✅` shipped with
tests and a pushed commit; `🟡` usable contract/reference implementation;
`⛔` hard-blocked on external toolchains/credentials (reported, not stubbed).

## `<issues_architecture>` — Issue classification & core SPIs

| Area                                                                                             | Status | Evidence                                                                                                                                 |
| :----------------------------------------------------------------------------------------------- | :----- | :--------------------------------------------------------------------------------------------------------------------------------------- |
| Fork-review fixes (#4): pipeline symlink guard, torrential `WaitMap`, RPC secret, plugin WS auth | ✅     | `develop` + torrential tests                                                                                                             |
| Launch hardening (#55–#59), uninstaller tests, launch-handler override                           | ✅     | #56 model tests, #59 UI override                                                                                                         |
| `MetadataProvider` SPI + core consumption                                                        | ✅     | `plugin-provider.ts`, `08.plugin-system.ts`                                                                                              |
| `PaymentGateway` SPI + webhook dispatch                                                          | ✅     | `commerce/webhooks.ts`, `[gateway].post.ts`                                                                                              |
| `CloudSavePathResolver` SPI (server + desktop + SDK schema) + consumption                        | ✅     | `saves/resolvers.ts`, `cloudsave/patterns.post.ts`                                                                                       |
| `StoreScanner` SPI + desktop aggregation                                                         | ✅     | `storeImport.ts`, `useStoreImport.ts`                                                                                                    |
| New plugin repositories (17)                                                                     | ✅     | created, built, tested, pushed                                                                                                           |
| Upstream PR 1 (platform/stability) & PR 2 (generic SPI)                                          | ✅     | PRs [#497](https://github.com/Drop-OSS/drop/pull/497)/[#498](https://github.com/Drop-OSS/drop/pull/498) from `upstream-pr/*`; docs below |

## `<ludusavi_cloud_saves>` — Client/Server cloud saves

| Item                                                          | Status | Evidence                                                |
| :------------------------------------------------------------ | :----- | :------------------------------------------------------ |
| Ludusavi CLI wrapper + `.tar.zst` + SHA-256                   | ✅     | `ludusavi.rs`                                           |
| Lifecycle hooks with real title + Proton/UMU prefix           | ✅     | `process_manager.rs`                                    |
| Authenticated server push/pull + size/history limits          | ✅     | `transport.rs`, `sync.rs`, SaveManager tests            |
| Object-permission fix (owner read)                            | ✅     | `saves/manager.ts`                                      |
| Hybrid conflict policy + modal                                | ✅     | `sync::decide_pre_launch`, `CloudSaveConflictModal.vue` |
| `SaveSlotManager.vue` wired into game detail                  | ✅     | `pages/library/[id]/index.vue`                          |
| Managed `ludusavi` provisioning into `<data>/tools/ludusavi/` | ✅     | `provision.rs`, `provision_ludusavi` command            |

## Tranches 4–7

| Tranche                            | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| :--------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #17 Content delivery               | ✅     | `downpour push` CDC chunker + zstd + memory/S3 upload with binary delta reuse (`--base`) and `--branch`/`--depot` manifest metadata; torrential LAN registry, SSDP + mDNS discovery backends, HTTP chunk fetcher with peer-chunk SHA-256 verification (`verify_chunk_sha256` / `fetch_verified_from_best_peer`); shader-cache discovery, packaging format doc (`docs/implementation/shader-cache-format.md`) and `stage_shader_caches` pre-launch staging + `drop-gamebox` index; PCGamingWiki externalized. QUIC is contract-only and deferred: `torrential/src/lan/mod.rs` defines the `ChunkFetcher` trait, HTTP is the implemented transport.           |
| #18 Handheld/Input/Overlay         | 🟡     | `input` crate (mapping, deadzones, gyro) with a working Linux **uinput** virtual-gamepad backend (`state_to_events` + device create/push/destroy) and a `NullBackend` fallback ✅; Big Picture page + on-screen keyboard ✅; the Windows ViGEm backend is **not implemented** ⛔; Vulkan/DXGI overlay ⛔ (needs the Vulkan layer toolchain).                                                                                                                                                                                                                                                                                                                |
| #19 Dropworks SDK & Multiplayer    | 🟡     | Server REST contract (`/api/v1/dropworks/session`, `/achievement`, `/leaderboard`) with token-derived users and leaderboard best-score retention ✅; TypeScript reference client + Rust binding + a tested C ABI (`libdropworks`, C smoke test) ✅; WebRTC/ICE NAT traversal and the C#/GDScript wrappers remain ⛔.                                                                                                                                                                                                                                                                                                                                        |
| #8 Achievements                    | ✅     | Prisma models + migration, unlock API, `drop:achievement:unlock` bus; leaderboard API (`submitScore` best-score retention, `listLeaderboard`) + `GET/POST /api/v1/client/leaderboards/:gameid/:key`; GSE `achievements.json` parser + addon bridge; RetroAchievements mapping/emission; desktop unlock toasts mounted.                                                                                                                                                                                                                                                                                                                                      |
| #20/#21 Social/Federation/Commerce | ✅     | verified reviews + community page (with per-game forum threads/replies and a public screenshot gallery); storefront price tiers (`GamePrice`, admin set + public resolve); purchase orders + Ed25519 ownership receipt issuance (`DROP_RECEIPT_SIGNING_KEY`) + webhook dispatch; federation presence + moderation (block/revoke/rate-limit), key rotation, opt-in library sharing scopes, and provenance-aware ODP discovery search; Drop Workshop `mod.json` registry + subscriptions; GameBox verifiable index snapshots/mirrors; depot endpoint validation; store-scanner aggregation. Store/payment provider API keys are operator-supplied (reported). |

## Hard blockers (reported, not stubbed)

- **Windows virtual gamepad** — the Linux `uinput` backend now exists
  (`input::uinput::UinputBackend`, reported by `supported_backends()` on Linux);
  the Windows ViGEm backend is not implemented and needs the ViGEm bus driver.
  When no native backend is available, `NullBackend` returns a precise
  `BackendUnavailable` error instead of silently no-op'ing.
- **Vulkan/DXGI in-game overlay** — requires the Vulkan layer toolchain and a
  DXGI hook. Only the slot names (`overlay:panel`, `overlay:quick-access` in
  `desktop/main/internal/plugins/types.ts`) and the client slot registry
  (`ClientPluginManager`) exist; no overlay host mounts them and there is no
  `OverlaySlot` SPI type.
- **External provider credentials** — SteamGridDB/LaunchBox/ScreenScraper/
  MobyGames API keys and Stripe/BTCPay secrets are operator-supplied.

## Known follow-ups

- **Genericize anti-cheat detection in the desktop host — done.** The host now
  exposes `plugin_game_find_files` and drops `AntiCheatReport`/`checkAntiCheat`
  from the SPI; `drop-gse` owns the EAC/BattlEye/Vanguard/Denuvo patterns and
  detects the capability at runtime (generic `findFiles`, legacy `checkAntiCheat`
  fallback). `@droposs/plugin-sdk` documents `ScopedGameScanner.findFiles` and is
  bumped to `0.5.0` (npm publish pending).

## Verification (all green)

```sh
pnpm --filter drop run test             # 13/13 files
pnpm --filter drop run typecheck        # 0
pnpm -C desktop/main run lint           # 0 errors
cargo +nightly test -p cloud_saves -p database -p input -p shader_cache
cd torrential && cargo +nightly test    # 28
cd cli && cargo +nightly test           # 7
pnpm -r run test                        # drop-plugin-sdk
# drop-gamebox, drop-federation, drop-gse, drop-retroachievements, and all 17
# plugin repos: build + tests green
```
