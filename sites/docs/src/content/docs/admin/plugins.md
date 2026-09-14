---
title: Plugins
---

Drop supports an extensible plugin runtime across both the server and desktop client.
A server plugin can register HTTP routes under `/api/v1/plugins/<id>/...`, subscribe/broadcast events, use namespaced storage, and handle WebSocket messages. Desktop client plugins can contribute UI panels, status badges, Play Actions, and game launch hooks. Plugins run **in-process**, so only install code you trust.

---

## Architecture & Toolchain

The developer toolchain and runtime contracts are maintained in [`@droposs/plugin-sdk`](https://github.com/Heretek-Games/drop-plugin-sdk):

- **SDK (`@droposs/plugin-sdk`)**: Public TypeScript contracts, JSON Schema, and mock harnesses (`MockPluginContext`, `MockClientPluginContext`).
- **CLI (`@droposs/plugin-cli`)**: Developer CLI (`drop-plugin`) providing `init`, `build`, `test`, `validate`, `sign`, and `pack`.

---

## Bundle Format

A plugin lives in `<dataDir>/plugins/<id>/` and contains:

| File                            | Purpose                                                                                          |
| :------------------------------ | :----------------------------------------------------------------------------------------------- |
| `drop-plugin.json`              | Manifest: `id`, `name`, `version`, `apiVersion`, `targets`, `capabilities`, `server`, `client` … |
| `index.js` (or `server.entry`)  | Server plugin module (default export with `init(ctx)`).                                          |
| `client.js` (or `client.entry`) | Optional client plugin module (default export with `init(ctx)`).                                 |

### `drop-plugin.json` Fields

- `id`, `name`, `version` — required.
- `apiVersion` — plugin API version (currently `2`; Drop maintains backwards compatibility with `1`).
- `targets` — `["server"]`, `["client"]`, or `["server", "client"]`.
- `capabilities` — explicitly declared permissions:
  - **Server**: `routes`, `storage`, `events`, `network`, `websocket`.
  - **Client**: `ui:slot`, `ui:play-action`, `ui:context-menu`, `ui:sidebar`, `ui:topbar`, `game:launch-hook`, `game:fs`, `game:scan`, `client:storage`, `client:ws`.
- `entry` — relative path to primary entry point (default `index.js`).
- `checksum` — SHA-256 hex digest of the primary entry file.
- `files` — mapping of relative bundle file paths to their individual SHA-256 digests. Required for multi-file bundles.
- `signature` — HMAC-SHA256 covering the aggregate bundle digest (or `checksum` for single-file bundles) under `DROP_PLUGIN_SIGNING_KEY`.

---

## Building, Signing & Packaging

Using the Drop Plugin CLI (`@droposs/plugin-cli`):

```sh
# Bundle TypeScript server and client sources into ESM dist/
npx @droposs/plugin-cli build .

# Validate manifest against schema
npx @droposs/plugin-cli validate .

# Sign drop-plugin.json with SHA-256 digests and HMAC signature
export DROP_PLUGIN_SIGNING_KEY="secret-key"
npx @droposs/plugin-cli sign .

# Package into a .dropplugin distribution archive
npx @droposs/plugin-cli pack . ./dist-package
```

Set `DROP_PLUGIN_REQUIRE_SIGNATURE=true` on the server to refuse unsigned bundles.

---

## Registry (Allow-list, Pinning & Remote Index)

Set `DROP_PLUGIN_REGISTRY` to a JSON file path or a remote HTTP/HTTPS URL (`https://.../registry.json`) to enforce an allow-list, pin exact versions, and verify aggregate bundle checksums:

```json
{
  "plugins": [
    {
      "checksum": "<sha256>",
      "downloadUrl": "https://plugins.example.com/sample-plugin.dropplugin",
      "id": "sample-plugin",
      "name": "Sample Plugin",
      "version": "1.0.0"
    }
  ]
}
```

- **Fail-Closed Default**: When configured, any unlisted plugin or any version/checksum mismatch is rejected at install time and load time.
- **Remote Fetching**: The server fetches remote registries with an automatic timeout and verifies response status; unreachable registries fail closed to protect integrity.

---

## Signing Key Distribution & Trust Guidance

By default, plugins run trusted in-process. To enforce cryptographic integrity and supply chain provenance:

1. **Require Signatures**: Set `DROP_PLUGIN_REQUIRE_SIGNATURE=true` on the server. Any bundle without a cryptographic `signature` is refused immediately.
2. **Key Distribution**: Set `DROP_PLUGIN_SIGNING_KEY="<hmac-secret>"` across build pipelines and the Drop server instance. The CLI `drop-plugin sign` signs the aggregate digest across all bundle files.
3. **Registry Pinning**: Combine with a pinned registry index to enforce dual verification: exact SHA-256 code digest plus cryptographic HMAC signature.

---

## Installing Bundles

### 1. Via Desktop Client Settings

Navigate to **Settings → Plugins & Extensions** and click **Upload .dropplugin / JSON** to select a `.dropplugin` package, or paste the bundle JSON directly. A capability consent dialog prompts the administrator to authorize declared permissions before installation.

### 2. Via Admin API (Install-by-URL or Multi-file Package)

Install via `POST /api/v1/plugins/install` with an admin token:

#### Install by URL:

```sh
curl -X POST "$DROP_URL/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://plugins.example.com/my-plugin.dropplugin" }'
```

#### Multi-file Package / `.dropplugin` Payload:

```sh
curl -X POST "$DROP_URL/api/v1/plugins/install" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "id": "my-plugin",
      "name": "My Plugin",
      "version": "1.0.0",
      "apiVersion": 2,
      "targets": ["server"],
      "capabilities": ["routes"],
      "entry": "dist/index.js",
      "files": {
        "dist/index.js": "<sha256>"
      }
    },
    "files": {
      "dist/index.js": "<base64>"
    }
  }'
```

#### Filesystem Copy:

Copy a bundle into `<dataDir>/plugins/<id>/` and reload:

```sh
curl -X POST "$DROP_URL/api/v1/plugins/reload" -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Management API

- `GET /api/v1/plugins` — list registered plugins and lifecycle status.
- `GET /api/v1/plugins/updates` — check installed plugins against the active registry for available version updates.
- `PATCH /api/v1/plugins/<id>/state` `{ "enabled": true|false }` — toggle plugin active state.
- `DELETE /api/v1/plugins/<id>/bundle` — remove an external plugin bundle from disk.
- `POST /api/v1/plugins/reload` — reload all external bundles from disk.

Built-in plugins cannot be removed.
