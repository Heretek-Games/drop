# Upstream PR 2 — Generic Plugin Runtime SPI

**Target:** `Drop-OSS/drop`
**Source:** `Heretek-Games/drop` (`upstream/pr2-generic-plugin-spi`)
**Goal:** land the generic, domain-agnostic plugin runtime so third parties can
extend Drop without forking. Contains **zero** hardcoded piracy, emulation,
VPN, or payment logic.

## Scope

### Runtime (`server/server/internal/plugins/`)

- `PluginManager` lifecycle: discovery of external bundles from
  `${dataDir}/plugins/*/drop-plugin.json`, dynamic routing
  `/api/v1/plugins/[pluginId]/...`, event bus, WebSocket gateway, isolated
  storage with migrations.
- Manifest verification: `apiVersion` gate, SHA-256 entry checksum, optional
  HMAC-SHA256 signature (`DROP_PLUGIN_SIGNING_KEY`), registry allow-list.
- Fail-closed capabilities: `routes`, `storage`, `events`, `network`,
  `websocket`, `metadata:provider`, `cloudsave:provider`, `commerce:payment`.
- Auth: browser sessions, `Bearer` tokens, and the desktop `JWT` scheme.

### Extension SPIs

- Server: `MetadataProvider`, `CloudSavePathResolver`, `PaymentGateway`.
- Client (desktop): `StoreScanner`, `MetadataProvider`, `CloudSavePathResolver`,
  overlay/UI slots, launch hooks.
- Bundled `hello-world` reference plugin and the upstream-compatibility tests
  proving a zero-plugin baseline leaves Drop in a pure vanilla state.

### SDK

- `@droposs/plugin-sdk` contracts + mock harness; `@droposs/plugin-cli` bundle
  signer (`drop-plugin sign`).

## Out of scope

- Every concrete plugin (metadata/store/payment/emulation/federation) lives in
  the Heretek external plugin repositories.

## Verification

```sh
pnpm --filter drop run test
pnpm --filter @droposs/plugin-sdk test
pnpm --filter @droposs/plugin-cli test
```
