#!/usr/bin/env bash
# Prepare the source tarball and debian/ directory consumed by the
# yuezk/publish-ppa-package action for the Drop desktop client.
#
# The Tauri client is compiled in CI; this script wraps the prebuilt `drop-app`
# binary plus its desktop/AppStream assets and materializes the packaging
# directory from the templates in distribution/debian/.
#
# Usage:
#   prepare-ppa-source.sh --channel <stable|alpha> --version <v> \
#     (--deb <path> | --binary <path>) --outdir <dir>
#
# Writes two key=value lines to stdout (tarball=, debian_dir=) and diagnostics
# to stderr, so it can be appended directly to $GITHUB_OUTPUT.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/distro/common.sh
source "$script_dir/common.sh"

channel=""
version=""
deb=""
binary_src=""
outdir=""
commit="${GITHUB_SHA:-local}"

while [[ $# -gt 0 ]]; do
  case "$1" in
  --channel)
    channel="${2:?missing value for --channel}"
    shift 2
    ;;
  --version)
    version="${2:?missing value for --version}"
    shift 2
    ;;
  --deb)
    deb="${2:?missing value for --deb}"
    shift 2
    ;;
  --binary)
    binary_src="${2:?missing value for --binary}"
    shift 2
    ;;
  --outdir)
    outdir="${2:?missing value for --outdir}"
    shift 2
    ;;
  --commit)
    commit="${2:?missing value for --commit}"
    shift 2
    ;;
  *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$channel" && -n "$version" && -n "$outdir" ]] || die "missing required arguments"
[[ -n "$deb" || -n "$binary_src" ]] || die "one of --deb or --binary is required"
[[ -z "$deb" || -f "$deb" ]] || die "deb not found: $deb"
[[ -z "$binary_src" || -f "$binary_src" ]] || die "binary not found: $binary_src"

require_cmd tar
if [[ -n "$deb" ]] && ! command -v dpkg-deb >/dev/null 2>&1; then
  require_cmd ar
fi

repo_root="$(distro_repo_root)"
source_name="$(distro_source_name "$channel")"
app_id="$(distro_app_id "$channel")"
upstream="$(distro_upstream_version "$channel" "$version")"
summary="$(distro_app_summary "$channel")"
assets_dir="$repo_root/distribution/flatpak/$app_id"

desktop_file="$app_id.desktop"
metainfo_file="$app_id.metainfo.xml"
icon_file="$app_id.png"

for asset in "$desktop_file" "$metainfo_file" "$icon_file"; do
  [[ -f "$assets_dir/$asset" ]] || die "missing distribution asset: $assets_dir/$asset"
done

mkdir -p "$outdir"
outdir="$(cd "$outdir" && pwd)"

tree_name="${source_name}-${upstream}"
tarball="$outdir/${tree_name}.tar.gz"
tree="$outdir/${tree_name}"
debian_dir="$outdir/debian"

rm -rf "$tarball" "$tree" "$debian_dir"
mkdir -p "$tree"

if [[ -n "$binary_src" ]]; then
  binary="$binary_src"
else
  binary="$(mktemp)"
  trap 'rm -f "$binary"' EXIT
  distro_extract_binary "$deb" "$binary"
fi

# Upstream payload (prebuilt binary + advertised desktop assets).
install -m755 "$binary" "$tree/drop-app"
install -m644 "$assets_dir/$desktop_file" "$tree/$desktop_file"
install -m644 "$assets_dir/$metainfo_file" "$tree/$metainfo_file"
install -m644 "$assets_dir/$icon_file" "$tree/$icon_file"

tar -C "$outdir" -czf "$tarball" "$tree_name"

# debian/ control tree, generated from the templates in distribution/debian.
mkdir -p "$debian_dir/source"
sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@APP_SUMMARY@/$summary/g" \
  "$repo_root/distribution/debian/control.in" >"$debian_dir/control"
sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@BIN_NAME@/$source_name/g" \
  -e "s/@DESKTOP_FILE@/$desktop_file/g" -e "s/@METAINFO_FILE@/$metainfo_file/g" \
  -e "s/@ICON_FILE@/$icon_file/g" \
  "$repo_root/distribution/debian/install.in" >"$debian_dir/${source_name}.install"
install -m755 "$repo_root/distribution/debian/rules" "$debian_dir/rules"
install -m644 "$repo_root/distribution/debian/copyright" "$debian_dir/copyright"
install -m644 "$repo_root/distribution/debian/source/format" "$debian_dir/source/format"

# Seed changelog: the action parses the source name and upstream version from
# this before regenerating the per-series changelog.
sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@UPSTREAM@/$upstream/g" \
  -e "s/@CHANNEL@/$channel/g" -e "s/@COMMIT@/$commit/g" \
  -e "s|@DATE@|$(date -R)|g" \
  "$repo_root/distribution/debian/changelog.in" >"$debian_dir/changelog"

echo "prepared PPA source for $channel: ${source_name} ${upstream}" >&2
printf 'tarball=%s\n' "$tarball"
printf 'debian_dir=%s\n' "$debian_dir"
