# Drop Project Roadmap — The Open-Source Steam Alternative

Drop is building a modern, open-source, self-hosted, and federated alternative to Steam and proprietary game distribution platforms. This document outlines our long-term architectural pillars, core systems, and phased development roadmap.

---

## 1. Vision & Architectural Pillars

Steam dominates PC gaming not just because it is a store, but because it is an integrated operating environment for games. To provide a complete, DRM-free, community-governed alternative, Drop systematically addresses each layer of that ecosystem:

| Steam Layer                    | Drop Replacement                    | Architectural Foundation                                                                                                              | Tracking Issue                                         |
| :----------------------------- | :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------- |
| **SteamPipe & SteamCMD**       | **Droplet + Torrential + Downpour** | Chunked content-addressed storage, LAN P2P streaming, binary delta updates, and the `downpour push` developer release CLI.            | [#17](https://github.com/Heretek-Games/drop/issues/17) |
| **Steam Client & Big Picture** | **Drop Desktop & Deck UI**          | Tauri v2 + Nuxt 4 client with a dedicated 10-foot gamepad interface, on-screen keyboard, and power management hooks.                  | [#18](https://github.com/Heretek-Games/drop/issues/18) |
| **Steam Input**                | **Drop Input**                      | Low-level cross-platform controller remapping (`evdev`/`uinput` on Linux, ViGEm on Windows), gyro aiming, and community layouts.      | [#18](https://github.com/Heretek-Games/drop/issues/18) |
| **GameOverlayRenderer**        | **Drop In-Game Overlay**            | Lightweight Vulkan layer (`VK_LAYER_DROP_overlay`) and DXGI hook providing in-game FPS, chat, friends, and screenshots (`Shift+Tab`). | [#18](https://github.com/Heretek-Games/drop/issues/18) |
| **Steamworks SDK**             | **Dropworks SDK**                   | Open C/Rust/C#/GDScript game integration SDK with zero-config WebRTC NAT traversal, lobbies, cloud saves, and achievements.           | [#19](https://github.com/Heretek-Games/drop/issues/19) |
| **Steam Community & Friends**  | **Drop Social & Hubs**              | Federated presence, party invites, cross-instance chat (WebSockets/Matrix), user guides, and verified playtime reviews.               | [#20](https://github.com/Heretek-Games/drop/issues/20) |
| **Steam Workshop**             | **Drop Workshop**                   | Open `mod.json` package format, 1-click subscription/installation, automatic updates, and load order management.                      | [#20](https://github.com/Heretek-Games/drop/issues/20) |
| **Steam Store (30% cut)**      | **Federated Storefront**            | Open Depot Protocol (ODP), catalog syndication, 0–5% platform fee, and offline-verifiable Ed25519 license receipts.                   | [#21](https://github.com/Heretek-Games/drop/issues/21) |

> **Master Epic Tracking Issue:** [#22 — Drop as the Open-Source Steam Alternative](https://github.com/Heretek-Games/drop/issues/22)

---

## 2. Phased Roadmap

### Phase 1: High-Performance Content Delivery & Developer Publishing ([#17](https://github.com/Heretek-Games/drop/issues/17))

- **Local LAN P2P Chunk Sharing**:
  - Automatic peer discovery via mDNS on local subnets.
  - P2P chunk transfer over HTTP/QUIC at multi-gigabit LAN speeds, reducing WAN bandwidth during LAN parties and multi-device homes.
- **`downpour push` Developer Tooling**:
  - Headless CLI for game developers to upload builds to target depots and manage release branches (`main`, `beta`, `nightly`).
  - Rolling hash chunking, Zstandard compression, and binary deltas.
- **Shader Pre-caching & Runtime Depots**:
  - Automated compilation and distribution of DXVK/VKD3D pipeline caches to eliminate shader compilation stutter on Linux/Steam Deck.

### Phase 2: Universal Runtime, Controller Mapper & In-Game Overlay ([#18](https://github.com/Heretek-Games/drop/issues/18))

- **Drop Big Picture / Handheld Mode**:
  - 10-foot controller-first UI with focus management and virtual keyboard for Steam Deck, ASUS ROG Ally, and living-room setups.
  - Battery awareness and clean sleep/suspend/resume handling.
- **"Drop Input" Virtual Controller Subsystem**:
  - Native gamepad translation, custom deadzones, gyro-to-mouse mapping, and shareable per-game input configurations.
- **"Drop In-Game Overlay"**:
  - Non-intrusive Vulkan/DirectX graphics overlay hook providing real-time FPS/frametime telemetry, friends chat, screenshot capture, and controller rebinding.

### Phase 3: "Dropworks" Game SDK & Zero-Config Multiplayer ([#19](https://github.com/Heretek-Games/drop/issues/19))

- **Native Dropworks SDK**:
  - Clean, idiomatic client libraries for C, Rust, C# (.NET/Unity), and GDScript (Godot).
  - High-level APIs for authentication, matchmaking lobbies, encrypted P2P messaging, and cloud save sync.
- **Zero-Config NAT Traversal & Userspace Mesh**:
  - Embedded WebRTC DataChannels and ICE/STUN/TURN negotiation, eliminating mandatory external daemons (`zerotier-cli`).
  - Seamless evolution of `drop-gse` for legacy games and Dropworks for new indie titles.
- **Verifiable Achievements & Global Leaderboards**:
  - Server-side stats tracking, time-stamped milestone unlocks, and anti-tamper challenge verification.

### Phase 4: Social Graph, Community Hubs & The Drop Workshop ([#20](https://github.com/Heretek-Games/drop/issues/20))

- **Federated Friends & Rich Presence**:
  - Real-time status ("In Main Menu", "In Level 4 - 3/4 Players [Join]").
  - Seamless in-game invites and cross-instance messaging.
- **Community Hubs & Verified Playtime Reviews**:
  - Dedicated game discussion spaces, user screenshot showcases, and reviews displaying playtime verified by the Drop client.
- **The Drop Workshop**:
  - Standardized mod manifest (`mod.json`) and repository engine.
  - 1-click mod subscriptions, dependency resolution, version locking, and conflict detection.

### Phase 5: Catalog Federation, Indie Commerce & Decentralized Store ([#21](https://github.com/Heretek-Games/drop/issues/21))

- **Open Depot Protocol (ODP) & Federation**:
  - Decentralized catalog syndication allowing home servers to subscribe to verified community and indie repositories.
- **Fair Developer Commerce**:
  - Direct developer monetization via Stripe, PayPal, and open crypto (BTCPay).
  - Low or zero platform take-rate (0–5%) directly returning revenue to creators.
  - Cryptographically signed (Ed25519) ownership receipts with zero intrusive DRM.
- **Universal Multi-Store Aggregator**:
  - Import existing libraries from Steam, GOG, Epic, and itch.io into Drop, establishing Drop as the singular daily-driver gaming hub.

---

## 3. Long-term goal tracks (Heretek fork)

Beyond the phased roadmap above, the following long-term tracks are tracked as
epics. They are complementary to the subsystem issues (#6–#15) and the phase
epics (#17–#21).

| Track                                                | Sister Repository                                                                 | Milestone | Summary                                                                                                |
| :--------------------------------------------------- | :-------------------------------------------------------------------------------- | :-------- | :----------------------------------------------------------------------------------------------------- |
| **Plugin SDK & Extensibility**                       | [Heretek-Games/drop-plugin-sdk](https://github.com/Heretek-Games/drop-plugin-sdk) | M1        | Official `@drop/plugin-sdk`, `drop-plugin` build/sign toolchain, and plugin runtime contracts.         |
| **Shared Game Metadata & Hash Database ("GameBox")** | [Heretek-Games/drop-gamebox](https://github.com/Heretek-Games/drop-gamebox)       | M2        | A stash-box-style fingerprint index: hash a game folder/executable and get back identity and metadata. |
| **Seedbox / qBittorrent Remote Depots**              | [Heretek-Games/drop-seedbox](https://github.com/Heretek-Games/drop-seedbox)       | M3        | qBittorrent integration and streaming remote depots, extending the Droplet/Torrential content system.  |
| **Friends Federation & Instance Peering**            | [Heretek-Games/drop-federation](https://github.com/Heretek-Games/drop-federation) | M4        | Syncthing-style instance identity and optional peering over an optional port forward or VPN.           |
| **GSE Multiplayer Engine**                           | [Heretek-Games/drop-gse](https://github.com/Heretek-Games/drop-gse)               | M1/M3     | Goldberg Steam Emulator patcher, fail-closed anti-cheat checks, and room orchestration.                |
| **ZeroTier & Mesh Orchestration**                    | [Heretek-Games/drop-zerotier](https://github.com/Heretek-Games/drop-zerotier)     | M1/M3     | ZeroTier One and ZTNET virtual network controller, Quadlet templates, and daemon manager.              |

The common thread: all six are developed and maintained in **dedicated sister repositories** as external plugins and modular extensions, keeping the core Drop distribution lean and directly compatible with upstream `Drop-OSS/drop`.

---

## 4. Contributing

We welcome contributions across all languages and layers of the stack:

- **Rust**: `torrential` (depots & chunk cache), `cli` (`downpour`), `desktop/src-tauri` (`process`, `gse-engine`, runtime).
- **TypeScript / Vue / Nuxt**: `server` (REST/WS API, library manager, plugins) and `desktop/main` (client UI).
- **Go**: `backend/core/` (background services).

Please consult [`AGENTS.md`](./AGENTS.md) for architectural conventions, toolchain requirements, and pre-push quality gates.
