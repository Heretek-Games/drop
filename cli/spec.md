# Downpour CLI Specification

`downpour [command] --opts`

Downpour is the official CLI tool for Drop administrators and game developers, providing SteamCMD-equivalent publishing workflows and depot management.

## Core Commands

- `connect <s3 endpoint> <key> <secret> [name]` - Connects to an S3/storage endpoint and saves credentials locally.
- `new <path/s3 name> <public endpoint>` - Initializes a depot at the endpoint; creates `manifest.json` and speedtest object.
- `upload <game id> <localpath> <path/s3 name>` - Legacy/simple upload of game files to a configured depot.
- `push <game id> <localpath> [options]` - **(Phase 1 Developer Publishing)**:
  - Generates droplet content-addressed chunk manifests with rolling checksums.
  - Computes binary deltas against previous release/branch manifests to upload only changed blocks.
  - Supports `--branch <main|beta|nightly>`, `--depot <windows|linux|assets>`, and `--description <notes>`.
  - Automatically invokes compression (zstd) before depot transmission.
- `copy <game id> <version id> <src path/s3 name> <dest path/s3 name>` - Copies versions between two depots.
- `mark [exists/absent] <game id> <version id> <path/s3 name>` - Modifies depot `manifest.json` state without copying.
- `manifest inspect <manifest-file>` - Validates and inspects a local droplet manifest for chunk integrity and recipe steps.
- `rename <public endpoint> <new public endpoint>` - Renames an endpoint (server API required).
- `delete <public endpoint>` - Deletes an endpoint (server API required).
