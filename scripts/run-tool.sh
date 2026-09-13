#!/usr/bin/env bash
# Run a lint/security tool from a git hook, resolving it in this order:
#   1. PATH
#   2. mise shims ($HOME/.local/share/mise/shims)
#   3. $HOME/.local/bin
#   4. `mise exec` without triggering an implicit install
# Fails with an actionable message when the tool is unavailable so hooks never
# silently skip a check.
#
# Usage: scripts/run-tool.sh <tool> [args...]
set -uo pipefail

tool="${1:?usage: run-tool.sh <tool> [args...]}"
shift

if command -v "$tool" >/dev/null 2>&1; then
  exec "$tool" "$@"
fi
for dir in "$HOME/.local/share/mise/shims" "$HOME/.local/bin"; do
  if [[ -x "$dir/$tool" ]]; then
    exec "$dir/$tool" "$@"
  fi
done
if command -v mise >/dev/null 2>&1 &&
  MISE_AUTO_INSTALL=0 mise which "$tool" >/dev/null 2>&1; then
  exec env MISE_AUTO_INSTALL=0 mise exec -- "$tool" "$@"
fi

echo "::error::$tool not found. Run 'mise install' (see .mise.toml)." >&2
exit 1
