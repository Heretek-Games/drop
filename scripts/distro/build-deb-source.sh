#!/usr/bin/env bash
# Assemble a Debian source package for the Drop desktop client and emit the
# signed .changes files for a Launchpad PPA.
#
# The Tauri client is compiled in CI; this script only wraps the prebuilt
# `drop-app` binary plus its desktop/AppStream assets in a Debian source tree.
#
# Usage:
#   build-deb-source.sh --channel <stable|alpha> --version <v> \
#     (--deb <path> | --binary <path>) --outdir <dir> \
#     [--distros "jammy noble"] [--commit <sha>] [--no-sign]
#
# Signing uses PPA_GPG_KEY_ID and expects the key to be imported and unlocked
# (see scripts/distro/setup-gpg.sh). Pass --no-sign for local dry runs.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/distro/common.sh
source "$script_dir/common.sh"

channel=""
version=""
deb=""
binary_src=""
outdir=""
distros="jammy noble"
commit="${GITHUB_SHA:-local}"
sign=1

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
  --distros)
    distros="${2:?missing value for --distros}"
    shift 2
    ;;
  --commit)
    commit="${2:?missing value for --commit}"
    shift 2
    ;;
  --no-sign)
    sign=0
    shift
    ;;
  *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$channel" && -n "$version" && -n "$outdir" ]] || die "missing required arguments"
[[ -n "$deb" || -n "$binary_src" ]] || die "one of --deb or --binary is required"
[[ -z "$deb" || -f "$deb" ]] || die "deb not found: $deb"
[[ -z "$binary_src" || -f "$binary_src" ]] || die "binary not found: $binary_src"

require_cmd dpkg-buildpackage
require_cmd tar
require_cmd date
if [[ -n "$deb" ]] && ! command -v dpkg-deb >/dev/null 2>&1; then
  require_cmd ar
fi

repo_root="$(distro_repo_root)"
source_name="$(distro_source_name "$channel")"
app_id="$(distro_app_id "$channel")"
upstream="$(distro_upstream_version "$channel" "$version")"
rev_prefix="$(distro_debian_revision_prefix "$channel")"
summary="$(distro_app_summary "$channel")"
assets_dir="$repo_root/distribution/flatpak/$app_id"

desktop_file="$app_id.desktop"
metainfo_file="$app_id.metainfo.xml"
icon_file="$app_id.png"

for asset in "$desktop_file" "$metainfo_file" "$icon_file"; do
  [[ -f "$assets_dir/$asset" ]] || die "missing distribution asset: $assets_dir/$asset"
done

mkdir -p "$outdir"
if [[ -n "$binary_src" ]]; then
  binary="$binary_src"
else
  binary="$(mktemp)"
  trap 'rm -f "$binary"' EXIT
  distro_extract_binary "$deb" "$binary"
fi

for distro in $distros; do
  ubuntu_version="$(distro_ubuntu_version "$distro")"
  full_version="${upstream}-${rev_prefix}~ubuntu${ubuntu_version}.1"
  tree_parent="$outdir/$distro"
  tree="$tree_parent/${source_name}-${upstream}"
  orig_tarball="$tree_parent/${source_name}_${upstream}.orig.tar.gz"

  rm -rf "$tree_parent"
  mkdir -p "$tree"

  # Upstream payload (prebuilt binary + advertised desktop assets).
  install -m755 "$binary" "$tree/drop-app"
  install -m644 "$assets_dir/$desktop_file" "$tree/$desktop_file"
  install -m644 "$assets_dir/$metainfo_file" "$tree/$metainfo_file"
  install -m644 "$assets_dir/$icon_file" "$tree/$icon_file"

  # debian/ control tree, generated from the templates in distribution/debian.
  mkdir -p "$tree/debian/source"
  sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@APP_SUMMARY@/$summary/g" \
    "$repo_root/distribution/debian/control.in" >"$tree/debian/control"
  sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@BIN_NAME@/$source_name/g" \
    -e "s/@DESKTOP_FILE@/$desktop_file/g" -e "s/@METAINFO_FILE@/$metainfo_file/g" \
    -e "s/@ICON_FILE@/$icon_file/g" \
    "$repo_root/distribution/debian/install.in" >"$tree/debian/${source_name}.install"
  install -m755 "$repo_root/distribution/debian/rules" "$tree/debian/rules"
  install -m644 "$repo_root/distribution/debian/copyright" "$tree/debian/copyright"
  install -m644 "$repo_root/distribution/debian/source/format" "$tree/debian/source/format"
  sed -e "s/@PACKAGE_NAME@/$source_name/g" -e "s/@VERSION@/$full_version/g" \
    -e "s/@DISTRO@/$distro/g" -e "s/@CHANNEL@/$channel/g" -e "s/@COMMIT@/$commit/g" \
    -e "s|@DATE@|$(date -R)|g" \
    "$repo_root/distribution/debian/changelog.in" >"$tree/debian/changelog"

  # Pristine upstream tarball (everything except debian/), with a top-level
  # ${source_name}-${upstream}/ directory as dpkg-source expects.
  tar -C "$tree_parent" --exclude="${source_name}-${upstream}/debian" \
    -czf "$orig_tarball" "${source_name}-${upstream}"

  build_args=(-S -sa)
  if [[ "$sign" -eq 1 && -n "${PPA_GPG_KEY_ID:-}" ]]; then
    build_args+=(-k"$PPA_GPG_KEY_ID")
  else
    build_args+=(-us -uc)
  fi

  (cd "$tree" && dpkg-buildpackage "${build_args[@]}")

  echo "built Debian source for $distro: ${source_name} ${full_version}"
done
