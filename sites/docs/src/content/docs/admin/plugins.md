---
title: Plugins
---

Drop supports server-side plugins. A plugin can register HTTP routes under
`/api/v1/plugins/<id>/...`, subscribe/broadcast events, use namespaced storage,
and handle WebSocket messages. Plugins run **in-process**, so only install code
you trust.

## Bundle format

A plugin lives in `<dataDir>/plugins/<id>/` and contains:

| File                    | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `drop-plugin.json`      | Manifest: `id`, `name`, `version`, `apiVersion`, `capabilities` … |
| `index.js` (or `entry`) | The plugin module (default export with `init(ctx)`).              |

`drop-plugin.json` fields:

- `id`, `name`, `version` — required.
- `apiVersion` — the plugin API version the plugin targets (currently `1`).
- `capabilities` — any of `routes`, `storage`, `events`, `network`, `websocket`.
- `entry` — entry filename relative to the bundle (default `index.js`).
- `checksum` — SHA-256 of the entry file (recommended).
- `signature` — HMAC-SHA256 of `checksum` under `DROP_PLUGIN_SIGNING_KEY`.

## Signing a bundle

```sh
# From server/
node dev-tools/sign-plugin.mjs path/to/my-plugin
```

Set `DROP_PLUGIN_SIGNING_KEY` to also write a signature. Set
`DROP_PLUGIN_REQUIRE_SIGNATURE=true` on the server to refuse unsigned bundles.

## Registry (allow-list / pinning)

Set `DROP_PLUGIN_REGISTRY` to a JSON file to require that external plugins are
listed, optionally pinning the version and entry checksum:

```json
{
  "plugins": [
    { "checksum": "<sha256>", "id": "sample-plugin", "version": "1.0.0" }
  ]
}
```

When the registry is non-empty, an unlisted plugin (or a version/checksum
mismatch) is rejected at install time and at load time.

## Installing

Install from the admin API (requires an admin token):

```sh
curl -X POST "$DROP_URL/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": { "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
                  "apiVersion": 1, "capabilities": ["routes"],
                  "checksum": "<sha256>" },
    "entry": "<base64 of index.js>"
  }'
```

Or copy a signed bundle into `<dataDir>/plugins/<id>/` and reload:

```sh
curl -X POST "$DROP_URL/api/v1/plugins/reload" -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Managing

- `GET /api/v1/plugins` — list plugins and status.
- `PATCH /api/v1/plugins/<id>/state` `{ "enabled": true|false }` — enable/disable.
- `DELETE /api/v1/plugins/<id>/bundle` — remove an external plugin.
- `POST /api/v1/plugins/reload` — reload external bundles from disk.

Built-in plugins cannot be removed.

## The `drop-gse` plugin

`drop-gse` adds peer-to-peer multiplayer rooms. Its behaviour is configured by
environment variables:

| Variable                | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `GSE_MESH_BACKEND`      | `zerotier`, `tailscale`, or `memory` (auto-detected when unset). |
| `GSE_ZEROTIER_URL`      | ZeroTier controller base URL (e.g. `http://localhost:9993`).     |
| `GSE_ZEROTIER_TOKEN`    | Controller `authtoken.secret` value.                             |
| `GSE_ZEROTIER_NODE`     | Controller node id.                                              |
| `GSE_TAILSCALE_API_KEY` | Tailscale API token (creates one-off ephemeral keys).            |
| `GSE_TAILSCALE_TAILNET` | Tailnet name, e.g. `example.com`.                                |
| `GSE_TAILSCALE_TAG`     | Pre-declared policy tag (default `tag:dropgse`).                 |
| `GSE_BLOCKED_APP_IDS`   | Comma-separated Steam AppIDs refused for rooms.                  |
| `GSE_BLOCKED_GAME_IDS`  | Comma-separated Drop game ids refused for rooms.                 |

Without any mesh backend env vars, an in-memory backend is used (development
only). Tailscale tags must be declared in the tailnet policy; the plugin reuses
one tag for all rooms (ZeroTier gives stronger per-room isolation).
