#!/usr/bin/env bash
# Assemble an RPM source tree and build an SRPM for Fedora COPR.
#
# The Tauri client is compiled in CI; this script only wraps the prebuilt
# `drop-app` binary plus its desktop/AppStream assets around
# distribution/rpm/drop-desktop-client.spec.
#
# Usage:
#   build-rpm-srpm.sh --channel <stable|alpha> --version <v> \
#     (--deb <path> | --binary <path>) --outdir <dir> [--release <n>]
#
# Prints the path of the produced .src.rpm on the last line.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/distro/common.sh
# shellcheck disable=SC1091
source "$script_dir/common.sh"

channel=""
version=""
deb=""
binary_src=""
outdir=""
release="1"

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
  --release)
    release="${2:?missing value for --release}"
    shift 2
    ;;
  *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$channel" && -n "$version" && -n "$outdir" ]] || die "missing required arguments"
[[ -n "$deb" || -n "$binary_src" ]] || die "one of --deb or --binary is required"
[[ -z "$deb" || -f "$deb" ]] || die "deb not found: $deb"
[[ -z "$binary_src" || -f "$binary_src" ]] || die "binary not found: $binary_src"

require_cmd rpmbuild
require_cmd tar
require_cmd sed

repo_root="$(distro_repo_root)"
source_name="$(distro_source_name "$channel")"
app_id="$(distro_app_id "$channel")"
upstream="$(distro_upstream_version "$channel" "$version")"
assets_dir="$repo_root/distribution/flatpak/$app_id"
spec_template="$repo_root/distribution/rpm/drop-desktop-client.spec"

desktop_file="$app_id.desktop"
metainfo_file="$app_id.metainfo.xml"
icon_file="$app_id.png"

for asset in "$desktop_file" "$metainfo_file" "$icon_file"; do
  [[ -f "$assets_dir/$asset" ]] || die "missing distribution asset: $assets_dir/$asset"
done
[[ -f "$spec_template" ]] || die "missing spec template: $spec_template"

tree_name="${source_name}-${upstream}"
tree_parent="$outdir/payload"
tree="$tree_parent/$tree_name"
src_dir="$outdir/src"
spec_out="$outdir/${source_name}.spec"

rm -rf "$tree_parent" "$src_dir" "$spec_out"
mkdir -p "$tree" "$src_dir"

if [[ -n "$binary_src" ]]; then
  binary="$binary_src"
else
  binary="$(mktemp)"
  trap 'rm -f "$binary"' EXIT
  distro_extract_binary "$deb" "$binary"
fi

install -m755 "$binary" "$tree/drop-app"
install -m644 "$assets_dir/$desktop_file" "$tree/$desktop_file"
install -m644 "$assets_dir/$metainfo_file" "$tree/$metainfo_file"
install -m644 "$assets_dir/$icon_file" "$tree/$icon_file"

# The SRPM must remember the channel: command-line `--with alpha` is not
# persisted, so flip the bcond default for the alpha build.
if [[ "$channel" == "alpha" ]]; then
  sed 's/^%bcond_with alpha$/%bcond_without alpha/' "$spec_template" >"$spec_out"
else
  cp "$spec_template" "$spec_out"
fi

# Persist the version/release into the spec itself. The `--define` flags below
# only apply to this transient `rpmbuild -bs`; COPR re-expands the spec inside
# the SRPM *without* them, so without this the spec falls back to the template
# default (`0.4.0`) and `Source0` points at a tarball name that does not exist.
# That mismatch caused every COPR build to fail with "Bad file: ...-0.4.0.tar.gz".
escaped_upstream="${upstream//&/\\&}"
escaped_release="${release//&/\\&}"
sed -i \
  -e "s|^%{!?_pkg_version: %global _pkg_version .*|%global _pkg_version ${escaped_upstream}|" \
  -e "s|^%{!?_pkg_release: %global _pkg_release .*|%global _pkg_release ${escaped_release}|" \
  "$spec_out"

tar -C "$tree_parent" -czf "$src_dir/${tree_name}.tar.gz" "$tree_name"

rpmbuild -bs \
  --define "_sourcedir $src_dir" \
  --define "_srcrpmdir $outdir" \
  --define "_pkg_version $upstream" \
  --define "_pkg_release $release" \
  "$spec_out"

srpm="$(find "$outdir" -maxdepth 1 -name '*.src.rpm' -print -quit)"
[[ -n "$srpm" ]] || die "rpmbuild did not produce an SRPM"
echo "built SRPM: $srpm"
