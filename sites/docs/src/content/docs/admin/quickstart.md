---
title: Quickstart
---

This guide quickly runs through how to get set up with Drop in about five minutes, depending on your experience.

## Setting up the instance

The easiest way to get Drop running is using our pre-built Docker container.

```yaml compose.yaml
services:
  postgres:
    image: postgres:14-alpine
    healthcheck:
      test: pg_isready -d drop -U drop
      interval: 30s
      timeout: 60s
      retries: 5
      start_period: 10s
    volumes:
      - ./db:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD=drop
      - POSTGRES_USER=drop
      - POSTGRES_DB=drop
  drop:
    image: ghcr.io/drop-oss/drop:0.4.0-rc-5
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - 3000:3000
    volumes:
      - ./library:/library
      - ./data:/data
    environment:
      - DATABASE_URL=postgres://drop:drop@postgres:5432/drop
      - EXTERNAL_URL=http://localhost:3000 # default, customise if accessing from another computer or behind a reverse proxy
```

**The main things in this `compose.yaml` is the volumes attached to the `drop` service:**

1. `./library` is where you will put your games to be imported into Drop. See '[Creating a library](/docs/admin/guides/creating-library/)' once you're set up.
2. `./data` is where Drop will store anything that's using the default file-system backed storage system. Typically, these are objects.

:::tip
If you want to, you can generate a more secure PostgreSQL username & password.
:::

:::tip Optional: depot chunk cache
If your game storage is slow (spinning disks, network storage) and you have a
fast local tier (SSD/NVMe/tmpfs), you can enable Drop's read-through chunk
cache. Chunks are content-addressed by their SHA-256 plaintext checksum, so
repeated requests are served from the fast tier and your storage disks are
protected from repeated reads.

Mount the fast disk into the container and set the cache environment variables:

```yaml
drop:
  volumes:
    - ./library:/library
    - ./data:/data
    - /mnt/fast-block:/fast-block
  environment:
    - DATABASE_URL=postgres://drop:drop@postgres:5432/drop
    - CHUNK_CACHE_DIR=/fast-block/drop-chunk-cache
    - CHUNK_CACHE_MAX_BYTES=500000000000 # evict above this size (bytes)
```

The cache is **off unless `CHUNK_CACHE_DIR` is set**, is best-effort (a cache
failure never fails a download), and stores **plaintext game data unencrypted
at rest** on that disk. Make sure `CHUNK_CACHE_MAX_BYTES` leaves headroom on
the mount.
:::

:::tip Optional: peer-to-peer multiplayer
The built-in `drop-gse` plugin adds multiplayer rooms over a per-room ZeroTier
mesh (managed by ZTNET by default). It is optional and needs a mesh backend plus
ZeroTier on player machines. See [**Multiplayer (drop-gse)**](/docs/admin/multiplayer/).
:::
