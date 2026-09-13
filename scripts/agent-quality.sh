#!/usr/bin/env bash
# Format + auto-fix a single file for AI coding agents (opencode, Claude Code,
# Cursor) and for manual use. Best-effort: reports what it did, never blocks.
#
# Usage: scripts/agent-quality.sh <file>
#
# Runs, depending on the file type:
#   - prettier --write            (web/config/markdown files)
#   - eslint --fix               (in the owning workspace, when one exists)
#   - ruff check --fix + format  (*.py)
#   - shfmt -w                   (*.sh/*.bash)
#   - cargo fmt                  (*.rs)
#   - gofmt -w                   (*.go)
# Static analysis without an autofix (shellcheck, hadolint) is left to the git
# hooks so an agent edit is never blocked.
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
run_tool="$repo_root/scripts/run-tool.sh"

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "usage: scripts/agent-quality.sh <file>" >&2
  exit 0
fi
# Normalise to a repo-relative path when possible.
rel="${file#"$repo_root"/}"

say() { echo "[agent-quality] $*"; }

# --- prettier for web/config/markdown files ---------------------------------
case "$rel" in
  pnpm-lock.yaml | *"/generated/"* | *"/.nuxt/"* | *"/.output/"* | *"/dist/"*) ;;
  *.js | *.cjs | *.mjs | *.ts | *.mts | *.cts | *.tsx | *.vue | *.json | *.jsonc | *.css | *.scss | *.html | *.md | *.yaml | *.yml)
    if (cd "$repo_root" && pnpm exec prettier --write --ignore-unknown "$rel" >/dev/null 2>&1); then
      say "prettier: formatted $rel"
    fi
    ;;
esac

# --- eslint (workspace-aware; fixable rules only) ---------------------------
eslint_dir=""
case "$rel" in
  server/*) eslint_dir="server" ;;
  desktop/main/*) eslint_dir="desktop/main" ;;
  libraries/base/*) eslint_dir="libraries/base" ;;
  sites/promo/*) eslint_dir="sites/promo" ;;
  sites/docs/*) eslint_dir="sites/docs" ;;
esac
if [ -n "$eslint_dir" ] &&
  { [ -f "$repo_root/$eslint_dir/eslint.config.js" ] ||
    [ -f "$repo_root/$eslint_dir/eslint.config.mjs" ]; }; then
  abs="$repo_root/$rel"
  if (cd "$repo_root/$eslint_dir" && pnpm exec eslint --fix "$abs" >/dev/null 2>&1); then
    say "eslint: fixed $rel"
  else
    say "eslint: unresolved issues in $rel (run: pnpm -C $eslint_dir run lint)"
  fi
fi

# --- language formatters ----------------------------------------------------
case "$rel" in
  *.py)
    "$run_tool" ruff check --fix "$repo_root/$rel" >/dev/null 2>&1 || true
    "$run_tool" ruff format "$repo_root/$rel" >/dev/null 2>&1 || true
    say "ruff: formatted $rel"
    ;;
  *.sh | *.bash)
    "$run_tool" shfmt -w "$repo_root/$rel" >/dev/null 2>&1 || true
    say "shfmt: formatted $rel"
    ;;
  *.rs)
    if (cd "$(dirname "$repo_root/$rel")" && "$run_tool" cargo fmt >/dev/null 2>&1); then
      say "cargo fmt: formatted $rel"
    fi
    ;;
  *.go)
    "$run_tool" gofmt -w "$repo_root/$rel" >/dev/null 2>&1 || true
    say "gofmt: formatted $rel"
    ;;
esac

exit 0
