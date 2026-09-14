# Roadmap Completion Status

Status of the two plans delivered for Heretek-Games/drop. `✅` shipped with
tests and a pushed commit; `🟡` landable contract/reference implementation;
`⛔` blocked on external toolchains/credentials.

## `<issues_architecture>` — Issue classification & core SPIs

| Area                                                                                             | Status | Evidence                                                                   |
| :----------------------------------------------------------------------------------------------- | :----- | :------------------------------------------------------------------------- |
| Fork-review fixes (#4): pipeline symlink guard, torrential `WaitMap`, RPC secret, plugin WS auth | ✅     | `develop` + torrential tests                                               |
| Launch hardening (#55–#59), uninstaller tests, launch-handler override                           | ✅     | #56 model tests, #59 UI override                                           |
| `MetadataProvider` / `PaymentGateway` SPI                                                        | ✅     | `plugins.test.ts`, boundary plan                                           |
| `CloudSavePathResolver` SPI (server + desktop + SDK schema)                                      | ✅     | commit `885bc3d1`, SDK `571d476`                                           |
| `StoreScanner` SPI + store plugins                                                               | ✅     | SDK + 4 store repos                                                        |
| New plugin repositories (17)                                                                     | ✅     | all created, built, tested, pushed                                         |
| Upstream PR 1 (platform/stability) & PR 2 (generic SPI)                                          | 🟡     | `docs/implementation/upstream-pr{1,2}-*.md`, branches `upstream/pr{1,2}-*` |

## `<ludusavi_cloud_saves>` — Client/Server cloud saves

| Item                                                               | Status | Evidence                                                |
| :----------------------------------------------------------------- | :----- | :------------------------------------------------------ |
| Ludusavi CLI wrapper + `.tar.zst` pack/unpack + SHA-256            | ✅     | `cloud_saves/src/ludusavi.rs` (10 tests)                |
| Lifecycle hooks with real title + Proton/UMU prefix                | ✅     | `process_manager.rs`                                    |
| Authenticated server push/pull + size/history limits               | ✅     | `transport.rs`, `sync.rs`, SaveManager tests            |
| Object-permission fix (owner read)                                 | ✅     | `saves/manager.ts`                                      |
| Hybrid conflict policy (rollback archive + modal)                  | ✅     | `sync::decide_pre_launch`, `CloudSaveConflictModal.vue` |
| `SaveSlotManager.vue` wired into game detail                       | ✅     | `pages/library/[id]/index.vue`                          |
| Managed `ludusavi` tool provisioning into `<data>/tools/ludusavi/` | 🟡     | discovery implemented; automated download pending       |

## Tranches 4–7

| Tranche                            | Status | Notes                                                                                                                                                                   |
| :--------------------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #17 Content delivery               | 🟡     | `downpour push` CDN chunker + LAN peer contract ✅; mDNS/SSDP backend, S3 uploader, DXVK hook ✅/🟡                                                                     |
| #18 Handheld/Input/Overlay         | 🟡     | `input` crate (deadzone/gyro/backend trait) + Big Picture page ✅; uinput/ViGEm backends ⛔ (need `/dev/uinput`/ViGEm), Vulkan/DXGI overlay ⛔ (Vulkan layer toolchain) |
| #8 Achievements                    | ✅     | Prisma models + migration, unlock API, `drop:achievement:unlock` bus, GSE `achievements.json` parser; desktop toasts 🟡                                                 |
| #20/#21 Social/Federation/Commerce | 🟡     | verified reviews + Ed25519 receipts + community page ✅; federation presence ✅; payments webhooks & multi-store wiring 🟡                                              |

## Verification (all green)

```sh
pnpm --filter drop run test        # 9/9 files
pnpm --filter drop run typecheck
cargo +nightly test -p cloud_saves -p database -p input
cd torrential && cargo +nightly test
pnpm -r run test                   # drop-plugin-sdk
# each of the 17 plugin repos: npm run build && npm test
```
