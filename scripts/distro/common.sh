#!/usr/bin/env bash
# Shared helpers for the distribution packaging scripts.
#
# Sourced by scripts/distro/build-deb-source.sh and
# scripts/distro/build-rpm-srpm.sh. Not meant to be executed directly.

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# Absolute path to the repository root.
distro_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# Reverse-DNS application identifier matching the Tauri identifier
# (org.droposs.client) for each channel.
distro_app_id() {
  case "$1" in
  stable) printf 'org.droposs.client' ;;
  alpha) printf 'org.droposs.client.Alpha' ;;
  *) die "unknown channel: $1" ;;
  esac
}

# Package/binary base name for each channel.
distro_source_name() {
  case "$1" in
  stable) printf 'drop-desktop-client' ;;
  alpha) printf 'drop-desktop-client-alpha' ;;
  *) die "unknown channel: $1" ;;
  esac
}

# Convert the Tauri/semver bundle version into a Debian/RPM upstream version.
# Tauri requires semver, so alphas look like "0.4.0-alpha.42.abc1234"; package
# managers need a tilde prerelease so alphas sort below the stable 0.4.0.
distro_upstream_version() {
  local channel="$1" version="$2"
  case "$channel" in
  stable)
    printf '%s\n' "$version"
    ;;
  alpha)
    if [[ "$version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-alpha\.([0-9]+)\.([0-9a-f]+)$ ]]; then
      printf '%s~alpha.%s+%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    else
      die "unexpected alpha version format: $version"
    fi
    ;;
  *)
    die "unknown channel: $channel"
    ;;
  esac
}

# Debian revision prefix: stable starts at 1, alpha at 0.
distro_debian_revision_prefix() {
  case "$1" in
  stable) printf '1' ;;
  alpha) printf '0' ;;
  *) die "unknown channel: $1" ;;
  esac
}

# Ubuntu series -> series version used in the Launchpad version suffix.
distro_ubuntu_version() {
  case "$1" in
  jammy) printf '22.04' ;;
  noble) printf '24.04' ;;
  *) die "unknown Ubuntu series: $1" ;;
  esac
}

distro_app_summary() {
  case "$1" in
  stable) printf 'Self-hosted game distribution and multiplayer platform client' ;;
  alpha) printf 'Self-hosted game distribution platform client (Alpha Preview)' ;;
  *) die "unknown channel: $1" ;;
  esac
}

# Extract the prebuilt Tauri binary from a .deb into $2.
#
# Uses dpkg-deb when available (Debian/Ubuntu); otherwise unpacks the ar
# container directly so this also works on Fedora, which ships `ar` and `tar`
# but not dpkg-deb.
distro_extract_binary() {
  local deb="$1" output="$2"

  if command -v dpkg-deb >/dev/null 2>&1; then
    dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/bin/drop-app >"$output" ||
      die "failed to extract usr/bin/drop-app from $deb"
  else
    require_cmd ar
    local tmp member
    tmp="$(mktemp -d)"
    (cd "$tmp" && ar x "$deb")
    member="$(find "$tmp" -maxdepth 1 -name 'data.tar.*' -print -quit)"
    [[ -n "$member" ]] || die "no data.tar member found in $deb"
    tar -xOf "$member" ./usr/bin/drop-app >"$output" ||
      die "failed to extract usr/bin/drop-app from $deb"
    rm -rf "$tmp"
  fi

  chmod +x "$output"
}
