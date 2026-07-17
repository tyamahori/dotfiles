#!/bin/bash
# PreToolUse hook (Bash matcher): deny bare python/python3 invocations so
# Python always runs through uv (see the Python section of
# agents/global-instructions.md). Matches python at a command position —
# start of string or after ; & | ( && || — optionally preceded by env-var
# assignments or `command`; `uv run python ...` is untouched because there
# python is an argument, not the command.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')

pattern='(^|[;&|(])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*)(command[[:space:]]+)?python3?([[:space:]]|$)'

if printf '%s' "$cmd" | grep -Eq "$pattern"; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Bare python/python3 is blocked on this machine. Run Python through uv instead: `uv run script.py`, `uv run python -c ...`, `uv run --with <pkg> ...`, or `uvx <tool>`. Inside a project with pyproject.toml/uv.lock, `uv run` uses the project environment."}}
EOF
fi

exit 0
