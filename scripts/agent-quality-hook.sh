#!/usr/bin/env bash
# Claude Code PostToolUse hook: format and auto-fix the file that was just
# edited, via the shared scripts/agent-quality.sh. Never blocks the agent.
set -uo pipefail

input="$(cat)"
file="$(
  printf '%s' "$input" | python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)

tool_input = data.get("tool_input") or {}
print(tool_input.get("file_path") or "")
'
)"

if [ -z "$file" ] || [ ! -f "$file" ]; then
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/agent-quality.sh" "$file" >/dev/null 2>&1 || true
exit 0
