#!/bin/bash
# PreToolUse hook (Bash matcher): deny bare python/python3 invocations so
# Python always runs through uv (see the Python section of
# agents/global-instructions.md). Matches python at a command position —
# start of string or after ; & | ( && || — optionally preceded by env-var
# assignments or `command`; `uv run python ...` is untouched because there
# python is an argument, not the command.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')

# Heredoc bodies are data, not commands — drop them before matching so a
# line like "python ..." inside a commit-message heredoc is not denied.
# The line opening the heredoc is kept (a `python3 <<EOF` command must
# still match). Only the first heredoc per line is tracked; an unmatched
# terminator skips the rest of the input, trading a possible false
# negative for never false-positiving on data.
stripped=$(printf '%s\n' "$cmd" | awk '
  skip {
    line = $0
    if (dash) sub(/^\t+/, "", line)
    if (line == delim) skip = 0
    next
  }
  { print }
  match($0, /<<-?[ \t]*['\''"]?[A-Za-z_][A-Za-z0-9_]*['\''"]?/) {
    m = substr($0, RSTART, RLENGTH)
    dash = (substr(m, 3, 1) == "-")
    gsub(/<<-?[ \t]*/, "", m)
    gsub(/['\''"]/, "", m)
    delim = m
    skip = 1
  }
')

pattern='(^|[;&|(])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*)(command[[:space:]]+)?python3?([[:space:]]|$)'

if printf '%s' "$stripped" | grep -Eq "$pattern"; then
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Bare python/python3 is blocked on this machine. FIRST load the `efficient-python` skill (Skill tool) if you have not already this session — it defines the required uv invocation forms and style rules. Then run Python through uv: `uv run script.py`, `uv run python -c ...`, `uv run --with <pkg> ...`, or `uvx <tool>`. Inside a project with pyproject.toml/uv.lock, `uv run` uses the project environment."}}
EOF
fi

exit 0
