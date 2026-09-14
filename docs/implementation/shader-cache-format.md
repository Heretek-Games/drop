# Shader-cache packaging format (Phase 1, #17)

DXVK/VKD3D compile pipeline state into `*.dxvk-cache` files. Drop pre-caches
them so a game does not stutter while shaders compile on first play. This
document fixes the packaging format shared by the client collector
(`desktop/src-tauri/shader_cache`) and the community index
(`drop-gamebox` `/shader-cache/*`).

## Package

A shader-cache package is a directory (or a deterministic archive of that
directory) containing:

```
manifest.json
shaders/<name>.dxvk-cache
shaders/<name>.vkd3d-cache
```

- Only `*.dxvk-cache` and `*.vkd3d-cache` files are included. Discovery walks
  the install directory and, on Linux, the Proton/UMU prefix `drive_c` tree
  (`shader_cache::find_shader_caches`).
- File names are flattened with a numeric prefix on collision
  (`shader_cache::collect_shader_caches`), so two caches with the same base
  name do not overwrite each other.

## `manifest.json`

```json
{
  "createdAt": 1760000000000,
  "driver": "amd",
  "dxvkVersion": "2.4.1",
  "entries": [{ "name": "game.dxvk-cache", "sha256": "…", "sizeBytes": 1234 }],
  "executable": "game.exe",
  "formatVersion": 1,
  "gameId": "uuid"
}
```

- `sha256` is the lowercase hex digest of the cache file's bytes and is the
  identity used by the index (`drop-gamebox` stores
  `shader-cache:<gameId>` → per-driver `{ sha256, sizeBytes, dxvkVersion }`).
- `driver` is a coarse bucket (`amd`, `nvidia`, `intel`) because state caches
  are not portable across vendors.
- `executable` is the game binary the cache was warmed against; Steam Deck and
  desktop caches are often interchangeable for the same build.

## Client behavior

1. **Collect (contribute):** discover caches, copy them into a package
   directory, hash each file, and upload the manifest to the community index.
2. **Stage (restore before launch):** before spawning the game, copy the
   newest matching package's caches into the install directory with
   `shader_cache::stage_shader_caches`. A locally warmed cache is preserved by
   default (`overwrite = false`); an explicit user action may force
   replacement.

## Trust

Shader caches are untrusted input from the community index. The client verifies
each file's SHA-256 against the manifest before staging, and the index
(`drop-gamebox`) only ranks entries by verified size/recency. Caches never
execute; they are data files consumed by the graphics driver.
