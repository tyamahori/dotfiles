#!/bin/bash
# PreToolUse hook (Bash matcher): deny shell read/search commands that have
# dedicated tools — grep/rg/find/head/tail, print-mode sed (-n), and plain
# cat — redirecting the model to Grep/Read/Glob (measured 2026-08-24: 38.7%
# of Bash calls over 14 days were replaceable read/search commands).
# Matches only at a command position — start of string or after ; ( && || —
# optionally preceded by env-var assignments or `command`. A position after
# a lone pipe is NOT a command position here: mid-pipeline filters like
# `git log | grep foo` stay allowed. sed without -n (edits) and cat with
# redirection or a heredoc (writes) stay allowed.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')

# Heredoc bodies are data, not commands — drop them before matching so a
# line like "grep ..." inside a heredoc is not denied. Same logic as
# deny-bare-python.sh: the opening line is kept, only the first heredoc per
# line is tracked, and an unmatched terminator skips the rest of the input.
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

# Command position: start, or after ; ( && || — deliberately not a lone |.
pos='(^|;|\(|&&|\|\|)[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*)(command[[:space:]]+)?'

deny() {
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Shell read/search commands are blocked on this machine — dedicated tools are cheaper and bound their output. Use the Grep tool instead of grep/rg, the Read tool (offset/limit) instead of cat/head/tail/sed -n, and the Glob tool instead of find. Mid-pipeline filters (e.g. `git log | grep foo`) are still allowed."}}
EOF
  exit 0
}

# grep/rg/find/head/tail at a command position.
if printf '%s' "$stripped" | grep -Eq "${pos}(grep|rg|find|head|tail)([[:space:]]|\$)"; then
  deny
fi

# sed in print mode: a flag cluster containing n (-n, -En, -ne, --quiet).
if printf '%s' "$stripped" | grep -Eq "${pos}sed[[:space:]]+(-[A-Za-z]*n[A-Za-z]*|--quiet|--silent)([[:space:]]|\$)"; then
  deny
fi

# cat without redirection or heredoc anywhere in the command (writes like
# `cat > file` and `cat <<EOF > file` pass through).
if printf '%s' "$stripped" | grep -Eq "${pos}cat([[:space:]]|\$)" \
  && ! printf '%s' "$cmd" | grep -q '[<>]'; then
  deny
fi

exit 0
