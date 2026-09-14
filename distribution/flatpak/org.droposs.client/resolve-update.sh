#!/usr/bin/env bash
# Update resolver for Drop (Stable).
#
# Resolves the latest stable GitHub release asset and outputs FlatPark resolver JSON:
#   { "version": "0.4.0", "releaseDate": "YYYY-MM-DD",
#     "sources": [ { "filename": "drop.deb", "url": "..." } ] }
set -euo pipefail

repo="Heretek-Games/drop"

need() { local cmd="$1"; command -v "$cmd" >/dev/null 2>&1 || { echo "missing command: $cmd" >&2; exit 1; }; }
need curl; need jq

releases="$(curl -fsSL --proto '=https' --tlsv1.2 ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
  "https://api.github.com/repos/${repo}/releases?per_page=50")"

# Filter for stable releases (non-draft, tagged vX.Y.Z, excluding alpha/beta/nightly)
release="$(jq -c '
  [ .[]
    | select(.draft == false and (.tag_name | test("^v?[0-9]+\\.[0-9]+")) and (.tag_name | test("alpha|beta|nightly") | not))
  ] | sort_by(.published_at) | last // empty' <<<"$releases")"

[[ -n "$release" ]] || { echo "no matching stable release found" >&2; exit 1; }

tag="$(jq -r '.tag_name' <<<"$release")"
version="${tag#v}"
date="$(jq -r '.published_at | split("T")[0]' <<<"$release")"

url="$(jq -r '
  .assets[]
  | select(.name | test("Drop\\.Desktop\\.Client_.*_amd64\\.deb$"))
  | .browser_download_url' <<<"$release" | head -n1)"

if [[ -z "$version" || -z "$url" ]]; then
  echo "failed to resolve drop release asset" >&2
  exit 1
fi
echo "resolved drop $version ($date): $url" >&2

jq -n --arg v "$version" --arg d "$date" --arg u "$url" \
  '{version:$v, releaseDate:$d, sources:[{filename:"drop.deb", url:$u}]}'
