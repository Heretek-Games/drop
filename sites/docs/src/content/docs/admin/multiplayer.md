---
title: Multiplayer (drop-gse)
---

`drop-gse` is a built-in Drop plugin that turns "launch a game" into "join a
multiplayer room": it deploys a Goldberg-family Steam emulator configured to
discover peers, and provisions a per-room virtual mesh network. It is
**optional** — a normal Drop install is unaffected until it is configured.

It splits into two independent parts:

- **Part A — GSE:** scans and patches the emulator on the client, writes
  `steam_settings/`, and restores the originals on exit. Works offline / on a
  LAN with no mesh.
- **Part B — LAN emulation:** a per-room mesh — ZeroTier via
  [ZTNET](https://github.com/sinamics/ztnet) by default, a raw self-hosted
  ZeroTier controller, or Tailscale.

Enable it under **Settings → Plugins** (it is enabled by default) — see
[Plugins](/docs/admin/plugins/) for the platform and bundle format.

## Prerequisites

- **Players** need [ZeroTier One](https://www.zerotier.com/download/) installed
  on the machine running the game: the client shells out to `zerotier-cli` to
  join and leave the room network. Without it, hosting/joining still works but
  the client reports an actionable error instead of connecting.
- **The server** needs a mesh backend (see below). With none configured it uses
  an in-memory backend, which is development-only.

## Configuration

| Variable                | Purpose                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `GSE_MESH_BACKEND`      | `ztnet`, `zerotier`, `tailscale`, or `memory` (auto-detected when unset). |
| `GSE_ZTNET_URL`         | ZTNET base URL, e.g. `http://ztnet:3000` (default ZeroTier backend).      |
| `GSE_ZTNET_ORG`         | ZTNET organization id that owns the room networks.                        |
| `GSE_ZTNET_TOKEN`       | ZTNET organization API token (`x-ztnet-auth`).                            |
| `GSE_ZEROTIER_URL`      | Raw controller base URL (advanced; e.g. `http://localhost:9993`).         |
| `GSE_ZEROTIER_TOKEN`    | Raw controller `authtoken.secret` value (advanced).                       |
| `GSE_ZEROTIER_NODE`     | Raw controller node id (advanced).                                        |
| `GSE_TAILSCALE_API_KEY` | Tailscale API token (creates one-off ephemeral keys).                     |
| `GSE_TAILSCALE_TAILNET` | Tailnet name, e.g. `example.com`.                                         |
| `GSE_TAILSCALE_TAG`     | Pre-declared policy tag (default `tag:dropgse`).                          |
| `GSE_BLOCKED_APP_IDS`   | Comma-separated Steam AppIDs refused for rooms.                           |
| `GSE_BLOCKED_GAME_IDS`  | Comma-separated Drop game ids refused for rooms.                          |

Backend selection in `resolveBackend()`: ZTNET → raw ZeroTier → Tailscale →
in-memory. A Drop deployment uses exactly **one** mesh backend; players do not
choose it (the client shows the configured backend read-only).

## ZeroTier via ZTNET (recommended)

ZTNET manages a self-hosted ZeroTier controller and adds an admin UI plus an
organization REST API. The optional `server/deploy-template/compose.ztnet.yaml`
overlay runs `zerotier` + `ztnet` + its database alongside Drop:

```sh
cd server/deploy-template
cp .env.ztnet.example .env.ztnet   # edit it
docker compose -f compose.yml -f compose.ztnet.yaml --env-file .env.ztnet up -d
```

The overlay:

- pins `postgres:15-alpine` (the `postgres:alpine` tag is now v18 and rejects a
  `/var/lib/postgresql/data` mount),
- sets `ZT_ADDR=http://zerotier:9993` (without it ZTNET reports a null
  controller),
- publishes the ZTNET UI on `http://localhost:3001`.

### Bootstrap (one-time)

Organization and API-token creation is tRPC-only, so it is a manual step (or
scripted for development):

1. Open the ZTNET UI (`http://localhost:3001`) and register the first user —
   that account becomes ZTNET's admin.
2. Create an **Organization** and copy its id.
3. Mint an **Organization API token**.
4. Set `GSE_ZTNET_ORG` / `GSE_ZTNET_TOKEN` in `.env.ztnet` and re-run the compose
   command so the `drop` service picks them up.

For local development `server/dev-tools/ztnet-bootstrap.mjs` automates steps 1–3
and prints the two values:

```sh
GSE_ZTNET_URL=http://localhost:3001 node server/dev-tools/ztnet-bootstrap.mjs
```

## Raw ZeroTier controller (advanced)

If you already run a controller and prefer not to use ZTNET, point Drop at its
service API with the controller authtoken and node id:

```sh
GSE_MESH_BACKEND=zerotier
GSE_ZEROTIER_URL=http://zerotier:9993
GSE_ZEROTIER_TOKEN=<authtoken.secret>
GSE_ZEROTIER_NODE=<10-hex node id>
```

Networks are created and members authorized through the controller API directly.

## Tailscale (advanced)

> **Desktop support is not implemented yet.** The server can provision Tailscale
> rooms, but the desktop client only joins ZeroTier networks automatically
> (`gse_mesh_join`). With a Tailscale backend, players must join the tailnet
> manually. Prefer ZTNET for a working end-to-end flow.

Tailscale cannot do true per-room subnets, so isolation relies on a policy tag.
Declare one tag (default `tag:dropgse`) in your tailnet policy and give Drop a
token that can create one-off ephemeral keys:

```sh
GSE_MESH_BACKEND=tailscale
GSE_TAILSCALE_API_KEY=<tailscale api token>
GSE_TAILSCALE_TAILNET=example.com
GSE_TAILSCALE_TAG=tag:dropgse
```

## Joining a room (players)

1. Open a game's page and choose **Multiplayer**.
2. Tick the consent box and **Create & Host Room**, or **Join** an existing one.
3. Drop asks the server for this member's credential, joins the room network
   with `zerotier-cli`, then reports its ZeroTier node address so the controller
   authorizes it and assigns a room address. The peer list is written into
   `custom_broadcasts.txt`.
4. **Launch With Room** starts the patched game; leaving the room tears the
   network membership down.

Hosting is capped per user and the room TTL is 4 hours; an expired host lease is
migrated to another member automatically.

## Compatibility & safety

- **Anti-cheat:** the client refuses to patch when EAC/BattleEye markers are
  present. Known-incompatible titles can also be blocked server-side with
  `GSE_BLOCKED_APP_IDS` / `GSE_BLOCKED_GAME_IDS`; room creation returns `409`.
- **Integrity:** originals are backed up (`*.orig` + a SHA-256 manifest) before
  patching and restored on exit; a crash-recovery sweep repairs interrupted
  sessions at startup.
- **Optional by design:** ordinary launches are untouched — the interceptor only
  runs when a room config exists (or `DROP_GSE_ENABLE` is set).

## Development / E2E

The backend check provisions a real network, authorizes a synthetic node,
asserts the assigned address, then tears down:

```sh
GSE_ZTNET_URL=http://localhost:3001 \
GSE_ZTNET_ORG=<org> GSE_ZTNET_TOKEN=<token> \
  pnpm --filter drop exec jiti dev-tools/gse-ztnet-check.ts
```

CI runs the same flow on GSE changes (`.github/workflows/ztnet-e2e.yml`). See
`AGENTS.md` for implementation details.
