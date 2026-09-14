#!/usr/bin/env bash
# Import the PPA signing key and unlock it non-interactively for debsign.
#
# Required environment:
#   PPA_GPG_PRIVATE_KEY  base64-encoded ASCII-armored private key
#   PPA_GPG_KEY_ID       signing key ID or fingerprint
# Optional:
#   PPA_GPG_PASSPHRASE   passphrase (omit for an unprotected key)
set -euo pipefail

: "${PPA_GPG_PRIVATE_KEY:?PPA_GPG_PRIVATE_KEY is required}"
: "${PPA_GPG_KEY_ID:?PPA_GPG_KEY_ID is required}"

export GNUPGHOME="${GNUPGHOME:-$HOME/.gnupg}"
mkdir -p "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

# Allow the agent to cache a passphrase preset below.
if ! grep -qs '^allow-preset-passphrase' "$GNUPGHOME/gpg-agent.conf"; then
  echo 'allow-preset-passphrase' >>"$GNUPGHOME/gpg-agent.conf"
fi

printf '%s' "$PPA_GPG_PRIVATE_KEY" | base64 -d | gpg --batch --import

# Restart the agent so it picks up allow-preset-passphrase.
gpgconf --kill gpg-agent
gpgconf --launch gpg-agent

if [[ -n "${PPA_GPG_PASSPHRASE:-}" ]]; then
  preset="$(command -v gpg-preset-passphrase || true)"
  if [[ -z "$preset" ]]; then
    for candidate in /usr/lib/gnupg/gpg-preset-passphrase /usr/libexec/gpg-preset-passphrase; do
      if [[ -x "$candidate" ]]; then
        preset="$candidate"
        break
      fi
    done
  fi
  [[ -n "$preset" ]] || {
    echo "error: gpg-preset-passphrase not found; install gnupg-utils" >&2
    exit 1
  }

  keygrips="$(gpg --batch --with-colons --with-keygrip --list-secret-keys "$PPA_GPG_KEY_ID" | awk -F: '/^grp:/ {print $10}')"
  if [[ -z "$keygrips" ]]; then
    keygrips="$(gpg --batch --with-keygrip --list-secret-keys "$PPA_GPG_KEY_ID" | sed -n 's/^ *Keygrip = //p')"
  fi
  [[ -n "$keygrips" ]] || {
    echo "error: could not determine keygrip for $PPA_GPG_KEY_ID" >&2
    exit 1
  }

  while IFS= read -r keygrip; do
    [[ -n "$keygrip" ]] || continue
    printf '%s' "$PPA_GPG_PASSPHRASE" | "$preset" --preset "$keygrip"
  done <<<"$keygrips"
fi

gpg --batch --list-secret-keys "$PPA_GPG_KEY_ID" >/dev/null
echo "imported GPG key for PPA signing"
