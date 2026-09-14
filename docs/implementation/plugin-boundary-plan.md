# Architecture Plan: Main Repo vs. Plugin Boundaries for Heretek-Games/drop

This document establishes the official architectural boundary between the core platform ([`drop`](https://github.com/Heretek-Games/drop)) and external plugins ([`drop-gse`](https://github.com/Heretek-Games/drop-gse), [`drop-zerotier`](https://github.com/Heretek-Games/drop-zerotier), [`drop-gamebox`](https://github.com/Heretek-Games/drop-gamebox), [`drop-seedbox`](https://github.com/Heretek-Games/drop-seedbox), [`drop-federation`](https://github.com/Heretek-Games/drop-federation), and third-party extensions).

---

## 1. Guiding Principles

1. **Upstream Alignment with `Drop-OSS/drop`**:
   - The core repository must remain clean of emulation hacks, piracy-adjacent tooling, proprietary store scrapers, external VPN daemons, or hardcoded payment processors.
   - Core improvements must be upstream-acceptable (PR 1: Platform/stability, PR 2: Generic Plugin SPI).
2. **First-Class Extensibility via `@droposs/plugin-sdk`**:
   - Specialized capabilities live in dedicated sister repositories or external plugins.
3. **Clean Plugin SPI**:
   - If a feature belongs in a plugin, the core repository provides the necessary generic SPI or hook so that plugins do not require monkey-patching or core fork-only modifications.

---

## 2. Complete Issue & Roadmap Classification Matrix

Review of all 22 issues on [`Heretek-Games/drop/issues`](https://github.com/Heretek-Games/drop/issues):

| Issue # | Issue Title                         | Classification                                                | Target Scope & Rationale                                                                                                                                                                                         |
| :-----: | :---------------------------------- | :------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#4**  | Fork review: static analysis & bugs | **Main Repo (`drop`)** + **`drop-gse`**                       | Core fixes (Torrential `WaitMap` leak, symlink path guards, plugin manifest hashing, cleartext token redaction) belong in `drop`; ZeroTier node ID hijacking and Tailscale key churn belong in `drop-gse`.       |
| **#6**  | Launch & executable configuration   | **Main Repo (`drop`)**                                        | Core process execution, launch directory resolution, multi-launch configuration, and chained installer execution.                                                                                                |
| **#7**  | Metadata providers & management     | **Main Repo (`drop`)** + **Plugins**                          | Core: Edition field (#329), advanced editor (#54), digital extras (#306), NFO formats (#294), offline caching (#218).<br/>Plugins: SteamGridDB (#206), ScreenScraper (#207), itch.io (#477), GameBox hash DB.    |
| **#8**  | Achievement system                  | **Main Repo (`drop`)** + **`drop-gse`**                       | Core: Data models (`AchievementDefinition`, `UserAchievement`), server API, client toasts, local unlock endpoint.<br/>Plugin (`drop-gse`): Intercept Goldberg Steam Emulator `achievements.json` / GBE protocol. |
| **#9**  | Cloud saves                         | **Main Repo (`drop`)** + **`drop-gamebox`**                   | Core: Snapshot versioning, storage backend (S3/local), client pre/post launch sync, path variable expansion.<br/>Plugin (`drop-gamebox`): Automated Ludusavi manifest resolution by executable hash.             |
| **#10** | Emulation support                   | **Main Repo (`drop`)** + **Plugins**                          | Core: Generic runner relation (`runnerGameId`, `runnerArgs`), multi-disc file picking, HTML5 web runner.<br/>Plugins: ROM metadata scraping, BIOS verification, and RetroArch core management.                   |
| **#11** | Redistributables & install scripts  | **Main Repo (`drop`)** + **Plugins**                          | Core: Shared depots, `installscript.vdf` parser, script pipeline runner.<br/>Plugins: Winetricks/Protonfixes community scripts, external script repos.                                                           |
| **#12** | Auth, SSO/OIDC & user management    | **Main Repo (`drop`)** (100%)                                 | OIDC identity provider (#41), PKCE (#292), SCIM/LDAP (#230), RBAC/parental gating (#239/#236), session management (#81).                                                                                         |
| **#13** | Linux, Proton & UMU support         | **Main Repo (`drop`)** (100%)                                 | Hosted Proton repo (#315), UMU GAMEID injection (#462), distro bug fixes, Flatpak/AppImage packaging.                                                                                                            |
| **#14** | Platform reach & self-hosting       | **Main Repo (`drop`)** + **`drop-seedbox`**                   | Core: Web client downloads (#283), S3 storage (#407), Nix flake (#440), Quadlet templates.<br/>Plugin (`drop-seedbox`): qBittorrent remote streaming depots.                                                     |
| **#15** | Library & admin quality-of-life     | **Main Repo (`drop`)**                                        | Core: Media carousels (#55/#57), persistent filters (#276), playtime tracking (#226), audit logs (#270), network sandbox (#463).                                                                                 |
| **#17** | Phase 1: Content Delivery & CLI     | **Main Repo (`drop`)** + **`drop-gamebox`**                   | Core: LAN P2P chunk streaming, `downpour push` CLI, DXVK shader packaging.<br/>Plugin (`drop-gamebox`): Shader cache community index.                                                                            |
| **#18** | Phase 2: Deck UI, Input & Overlay   | **Main Repo (`drop`)**                                        | Core: 10-foot Big Picture UI, Drop Input gamepad mapper, Vulkan/DXGI in-game overlay.                                                                                                                            |
| **#19** | Phase 3: Dropworks SDK & Multi      | **Main Repo (`drop`)** + **`drop-gse`** + **`drop-zerotier`** | Core: Native Dropworks SDK, WebRTC ICE NAT traversal, leaderboards.<br/>Plugins: `drop-gse` (Goldberg/anti-cheat), `drop-zerotier` (VPN daemon).                                                                 |
| **#20** | Phase 4: Social, Hubs & Workshop    | **Main Repo (`drop`)** + **`drop-federation`** + **Plugins**  | Core: Local friends, presence, community hubs, Drop Workshop (`mod.json`).<br/>Plugins: `drop-federation` (Matrix/peering), NexusMods connector.                                                                 |
| **#21** | Phase 5: Federation & Commerce      | **Main Repo (`drop`)** + **Plugins**                          | Core: Open Depot Protocol, developer publishing portal, Ed25519 receipt verification.<br/>Plugins: Payment gateways (Stripe/BTCPay), Multi-store library aggregators (GOG, Epic, Steam).                         |
| **#22** | Master Tracking Epic                | **Tracking**                                                  | Master container tracking issue.                                                                                                                                                                                 |
| **#55** | Multiple setup installers           | **Main Repo (`drop`)**                                        | Shipped in PR #60 (`prepare_pipeline` run_command chaining).                                                                                                                                                     |
| **#56** | Optional uninstaller                | **Main Repo (`drop`)**                                        | Landed in PR #60 (schema + execution); follow-up regression tests in `drop`.                                                                                                                                     |
| **#57** | Native HTML game support            | **Main Repo (`drop`)**                                        | Shipped in PR #60 (system URL opener wrapper).                                                                                                                                                                   |
| **#58** | BOM preservation regression test    | **Main Repo (`drop`)**                                        | Shipped in PR #60 (droplet round-trip test).                                                                                                                                                                     |
| **#59** | Launch diagnostics                  | **Main Repo (`drop`)**                                        | Landed in PR #60; UI error dialog override surfacing in `desktop/main`.                                                                                                                                          |

---

## 3. Required Plugin SPI Extensions

To enable external plugins without core pollution, the following extension points are designed:

### A. `MetadataProvider` SPI (Server/Client)

- **Target**: `drop/server/server/internal/plugins/types.ts` and `@droposs/plugin-sdk`
- **Hook**: `ctx.registerMetadataProvider(provider: MetadataProvider)`
- **Capability**: `metadata:provider`
- **Use Case**: Allows `drop-steamgriddb`, `drop-screenscraper`, and `drop-itch` to feed search results and artwork directly into the admin import flow.

### B. `StoreScanner` SPI (Client Desktop)

- **Target**: `drop-plugin-sdk/packages/plugin-sdk/src/types.ts` and `desktop/src-tauri`
- **Hook**: `ctx.registerStoreScanner(scanner: StoreScanner)`
- **Capability**: `client:library-scan`, `system:command`
- **Use Case**: Enables Playnite-style store aggregators (`drop-library-gog`, `drop-library-epic`, `drop-library-steam`) to detect installed games.

### C. `PaymentGateway` SPI (Server)

- **Target**: `drop/server/server/internal/plugins/types.ts` and `@droposs/plugin-sdk`
- **Hook**: `ctx.registerPaymentGateway(gateway: PaymentGateway)`
- **Capability**: `commerce:payment`
- **Use Case**: Modular payment processors (Stripe, BTCPay Server) for Phase 5 indie commerce without baking crypto or proprietary APIs into core.

### D. Overlay Slots Expansion (Client Desktop)

- **Target**: `UISlotName` in `drop-plugin-sdk`
- **Slots**: `"overlay:panel"` and `"overlay:quick-access"`
- **Use Case**: Enables plugins (GSE room coordinator, friends chat) to render inside the native Vulkan/DXGI in-game overlay.

---

## 4. SPI Implementation & Verification Status

The generic SPI contracts have been formally codified and verified across the workspace:

1. **`drop-plugin-sdk`**:
   - `ServerCapability`: Extended with `"metadata:provider"`, `"commerce:payment"`.
   - `ClientCapability`: Extended with `"metadata:provider"`, `"client:library-scan"`.
   - `UISlotName`: Extended with `"overlay:panel"`, `"overlay:quick-access"`.
   - Manifest Schema: Updated in `schema/drop-plugin.schema.json`.
   - Mock Harness: `MockPluginContext` and `MockClientPluginContext` updated with SPI registration, getter, and capability-assertion test suites in `test/sdk.test.ts`.

2. **`drop` Core**:
   - `types.ts`: Synchronized contracts for `MetadataProvider`, `StoreScanner`, `PaymentGateway`.
   - `PluginManager`: Implemented registration hooks, isolation/unregistration lifecycle cleanup, and inspection queries (`getMetadataProviders()`, `getPaymentGateways()`).
   - Automated Regression Tests: Integrated into `plugins.test.ts` and `upstream_compatibility.test.ts`, proving zero core residue and fail-closed permission gating.
