# Remote Depot Stream Contract

**Tracking Issues:** [#94](https://github.com/Heretek-Games/drop/issues/94), [#98](https://github.com/Heretek-Games/drop/issues/98), [#99](https://github.com/Heretek-Games/drop/issues/99), [#100](https://github.com/Heretek-Games/drop/issues/100)  
**Status:** Accepted  
**Applies to:** Core Server (`server`), Rust Engine (`torrential`), and Storage Plugins (`drop-seedbox`, `drop-federation`)

---

## 1. Overview

A **Remote Depot** allows a Drop instance to serve game content to desktop clients without requiring the entire game payload to reside on the local filesystem. This powers remote seedbox streaming (`drop-seedbox`), P2P/federated depot sharing (`drop-federation`), and object-storage backed depots.

The depot pipeline consumes remote depots by resolving a `DepotDownloadStream` from a registered `storage:depot` provider (`DepotStorageProvider`) and piping byte ranges into the Rust `torrential` process, which chunks, encrypts, and caches them for the client.

```
+------------------+         +------------------+         +--------------------------+
|  Desktop Client  | <=====> |  Rust Torrential | <=====> |    Drop Server Loopback  |
|  (Tauri Downpour)| Chunks  | (Remote Backend) | Ranges  |   Bridge (TORRENTIAL_RPC) |
+------------------+         +------------------+         +--------------------------+
                                                                       |
                                                                       v
                                                          +--------------------------+
                                                          |   DepotStorageProvider   |
                                                          |  (drop-seedbox / qBit)   |
                                                          +--------------------------+
```

---

## 2. Stream & Mapping Models

### 2.1 Continuous Byte Stream (Default)

The primary and canonical remote depot model is a **continuous byte stream**.

In this model:

1. The remote depot represents a single continuous byte sequence (such as a raw disk image `.iso`, multi-file torrent stream, or archive container).
2. The version's `manifest.json` defines file entries:
   ```json
   {
     "filename": "game.exe",
     "length": 5242880,
     "permissions": 493,
     "start": 1048576
   }
   ```
3. A chunk request for bytes `[start .. end]` of `file` maps directly to depot stream offset:
   $$\text{stream\_offset} = \text{file.start} + \text{start}$$
   $$\text{stream\_length} = \text{end} - \text{start}$$
4. The provider fulfills range requests over the full depot byte stream, addressing offsets `[0 .. depot_total_size)`.

### 2.2 Provider Delivery Types

A `DepotDownloadStream` returned by `DepotStorageProvider.resolveDepotStream(depotId, gameId)` supports two delivery types:

1. **Direct HTTP Range Stream (`url` + optional `headers`)**:
   - An HTTP(S) endpoint that supports RFC 7233 byte-range requests (`Range: bytes=start-end`).
   - If the endpoint is directly reachable by Torrential (e.g. an S3 pre-signed URL or authenticated seedbox WebUI stream), Torrential fetches ranges directly.
2. **Process-Local Callback (`pieceReader(offset, length)`)**:
   - A server-side TypeScript callback:
     ```typescript
     pieceReader: (offset: number, length: number) => Promise<Uint8Array>;
     ```
   - Units are strictly **bytes**, not torrent pieces. The provider internally maps byte offsets `[offset .. offset + length)` to torrent pieces, waits for buffer assembly, and returns the requested slice.
   - Because TypeScript callbacks cannot cross FFI/RPC into Rust, they are bridged through a loopback HTTP range endpoint.

---

## 3. Loopback Byte-Range Bridge

For `pieceReader`-backed streams, the Drop server exposes a loopback-only HTTP endpoint:

```http
GET /api/v1/internal/depot/:gameId/:depotId/range
X-Torrential-Secret: <TORRENTIAL_RPC_SECRET>
Range: bytes=1048576-2097151
```

### Constraints:

- **Localhost Only**: The endpoint rejects connections whose peer IP is not `127.0.0.1` or `::1` (403 Forbidden). It is never exposed through reverse proxies.
- **Shared Secret**: The request must supply `X-Torrential-Secret` matching `process.env.TORRENTIAL_RPC_SECRET` (401 Unauthorized).
- **Responses**:
  - `206 Partial Content` with `Content-Range: bytes <start>-<end>/<total>` and binary payload.
  - `416 Range Not Satisfiable` if the range is out of bounds.
  - `503 Service Unavailable` with `Retry-After: 2` if the piece is downloading.

---

## 4. Sparse & Incomplete Content Semantics

When a remote depot is downloading (e.g. seedbox play-while-download):

1. **Transient / In-Progress Ranges**:
   - If the requested range falls into a torrent piece that is still downloading, the provider must either:
     - Block up to a short configurable grace period (default 500ms) waiting for piece completion.
     - Return a transient error (`statusCode: 503`, statusMessage: `Piece downloading`).
   - Torrential treats 503 with exponential backoff and retry (up to 3 attempts) before failing the chunk request.
2. **Permanent Errors**:
   - Unmapped game, invalid credentials, or network failure return 404/502. Torrential fails the chunk immediately without looping retries.

---

## 5. Authorization & ACL Boundary

1. **Client -> Torrential**: Desktop clients authenticate with standard user session / Bearer tokens or the HMAC-derived download token. Only users with valid `Game` library access can initiate downloads.
2. **Torrential -> Loopback Bridge**: Authorized exclusively via `TORRENTIAL_RPC_SECRET`.
3. **Loopback Bridge -> Remote Provider**: The Drop server verifies `gameId` ownership and tenant isolation before calling the provider's `resolveDepotStream(depotId, gameId)`. Provider tokens and headers are never returned to the desktop client.

---

## 6. Chunk Cache Integration

Reads from remote depot streams are byte-range identical to local file reads.
Once a range is retrieved, Torrential calculates its plaintext SHA-256 hash and commits it to the local read-through chunk cache (`torrential/src/downloads/cache.rs`). Subsequent client requests for the same chunk hit the local SSD cache, eliminating remote network round trips.
