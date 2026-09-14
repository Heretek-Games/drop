---
title: Multiplayer (drop-gse + drop-zerotier)
---

Drop multiplayer is provided by two independent external plugins that work
together:

- **`drop-gse`** turns "launch a game" into "join a multiplayer room". It scans
  and patches a Goldberg-family Steam emulator on the client, writes
  `steam_settings/`, and restores the originals on exit. It also owns the room
  lifecycle (create/join/leave, host leases, credentials).
- **`drop-zerotier`** is the mesh provider. It provisions a per-room virtual
  network against a **ZTNET controller you supply** (or a raw self-hosted
  ZeroTier controller / Tailscale tailnet) and joins clients to it with
  `zerotier-cli`.

Both are **optional** — a normal Drop install is unaffected until they are
installed and configured. Install them under **Settings → Plugins**; see
[Plugins](/docs/admin/plugins/) for the platform and bundle format.

`drop-zerotier` no longer bundles a controller. You run ZTNET (plus its ZeroTier
controller) yourself and give the plugin an endpoint + API token. The two
plugins coordinate over the server-side plugin event bus: `drop-gse` announces
room membership, and `drop-zerotier` provisions networks, authorizes nodes, and
reports mesh addresses back.

## Prerequisites

- **Players** need [ZeroTier One](https://www.zerotier.com/download/) installed
  on the machine running the game. The `drop-zerotier` client addon runs
  `zerotier-cli` through Drop's allowlisted native-command capability
  (`system:command` → `zerotier-cli`). Without ZeroTier, joining reports an
  actionable error instead of connecting.
- **The server** needs `drop-zerotier` configured with a mesh backend (below).
  With none configured it falls back to an in-memory backend, which is
  development-only.
- **A controller** for the default path: a running
  [ZTNET](https://ztnet.network) instance with an organization and an API token.

## Configuration (`drop-zerotier`)

Set these on the Drop server (environment). `MESH_BACKEND` is auto-detected from
whichever credentials are present when unset.

| Variable            | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `MESH_BACKEND`      | `ztnet`, `zerotier`, `tailscale`, or `memory` (auto-detected when unset). |
| `ZTNET_URL`         | ZTNET base URL, e.g. `https://ztnet.example.com` (default ZeroTier path). |
| `ZTNET_ORG`         | ZTNET organization id that owns the room networks.                        |
| `ZTNET_TOKEN`       | ZTNET organization API token (`x-ztnet-auth`).                            |
| `ZEROTIER_URL`      | Raw controller base URL (advanced; e.g. `http://localhost:9993`).         |
| `ZEROTIER_TOKEN`    | Raw controller `authtoken.secret` value (advanced).                       |
| `ZEROTIER_NODE`     | Raw controller node id (advanced).                                        |
| `TAILSCALE_API_KEY` | Tailscale API token (creates one-off ephemeral keys).                     |
| `TAILSCALE_TAILNET` | Tailnet name, e.g. `example.com`.                                         |
| `TAILSCALE_TAG`     | Pre-declared policy tag (default `tag:dropzerotier`).                     |

Backend selection order (when `MESH_BACKEND` is unset): ZTNET → raw ZeroTier →
Tailscale → in-memory. A deployment uses exactly **one** mesh backend; players
do not choose it.

### ZTNET (recommended)

Install ZTNET yourself and connect it to a self-hosted ZeroTier controller — see
the [ZTNET documentation](https://ztnet.network). Then, in the ZTNET UI:

1. Register the first user (this account becomes the ZTNET admin).
2. Create an **Organization** and copy its id into `ZTNET_ORG`.
3. Mint an **Organization API token** and set it as `ZTNET_TOKEN`.

The Drop server must be able to reach `ZTNET_URL`, and ZTNET must be able to
reach its ZeroTier controller. ZTNET rate-limits the REST API to 50
requests/minute; room networks are provisioned once and cached.

### Raw ZeroTier controller (advanced)

If you already run a controller and prefer not to use ZTNET:

```sh
MESH_BACKEND=zerotier
ZEROTIER_URL=http://zerotier:9993
ZEROTIER_TOKEN=<authtoken.secret>
ZEROTIER_NODE=<10-hex node id>
```

### Tailscale (advanced)

> **Desktop support is ZeroTier-only.** The `drop-zerotier` client addon joins
> ZeroTier networks; with a Tailscale backend, players must join the tailnet
> manually.

## Configuration (`drop-gse`)

| Variable               | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `GSE_BLOCKED_APP_IDS`  | Comma-separated Steam AppIDs refused for rooms.  |
| `GSE_BLOCKED_GAME_IDS` | Comma-separated Drop game ids refused for rooms. |

The mesh is no longer configured on `drop-gse`; its former `GSE_MESH_BACKEND` /
`GSE_ZTNET_*` / `GSE_ZEROTIER_*` / `GSE_TAILSCALE_*` variables are gone and are
read by `drop-zerotier` instead.

## Joining a room (players)

1. Open a game's page and choose **Multiplayer**.
2. Tick the consent box and **Create & Host Room**, or **Join** an existing one.
3. On launch, the `drop-zerotier` client addon asks the server for the user's
   active networks, runs `zerotier-cli join <nwid>`, and reports its ZeroTier
   node id. The server authorizes the node on the controller and assigns a room
   address, which `drop-gse` writes into `custom_broadcasts.txt`.
4. **Launch With Room** starts the patched game; leaving the room revokes the
   membership and the client leaves the network.

Hosting is capped per user and the room TTL is 4 hours; an expired host lease is
migrated to another member automatically.

## Compatibility & safety

- **Anti-cheat:** the client refuses to patch when EAC/BattleEye markers are
  present. Known-incompatible titles can also be blocked server-side with
  `GSE_BLOCKED_APP_IDS` / `GSE_BLOCKED_GAME_IDS`; room creation returns `409`.
- **Integrity:** originals are backed up before patching and restored on exit.
- **Network revocation:** leaving or expiring a room immediately revokes the
  member's controller authorization.
- **Native command allowlist:** the client addon may only run the binaries
  declared in its manifest (`client.commands`), enforced by the desktop host.
- **Optional by design:** ordinary launches are untouched — the interceptor only
  runs when a room config exists.
