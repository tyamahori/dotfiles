#!/bin/sh
# Report the number of running Claude Code subagents as the `subagents` pane
# metadata token, displayed via [ui.sidebar.agents] rows ("$subagents") in
# herdr/config.toml. Subagents run in-process without a PTY, so herdr cannot
# see them as agents; a display-only token is the sanctioned side channel.
# The OMP counterpart is omp/extensions/herdr-subagents.ts.
# Registered on SubagentStart, SubagentStop, and SessionEnd. Hook processes
# are stateless, so one marker file per agent_id (creation and removal are
# atomic; concurrent batch spawns cannot lose increments) carries the count
# in a per-pane, per-session temp directory.

[ "${HERDR_ENV:-}" = 1 ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Panes created by older herdr servers lack HERDR_BIN_PATH; fall back to PATH.
herdr_bin="${HERDR_BIN_PATH:-herdr}"
command -v "$herdr_bin" >/dev/null 2>&1 || exit 0

input=$(cat)
event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
agent=$(printf '%s' "$input" | jq -r '.agent_id // empty')
[ -n "$session" ] || exit 0

pane_key=$(printf '%s' "$HERDR_PANE_ID" | tr -c 'A-Za-z0-9' '_')
dir="${TMPDIR:-/tmp}/herdr-subagents-claude-${pane_key}${session}"

case "$event" in
  SubagentStart)
    [ -n "$agent" ] || exit 0
    mkdir -p "$dir"
    : > "$dir/$agent"
    ;;
  SubagentStop)
    [ -n "$agent" ] || exit 0
    rm -f "$dir/$agent"
    ;;
  SessionEnd)
    rm -rf "$dir"
    ;;
  *)
    exit 0
    ;;
esac

count=0
for marker in "$dir"/*; do
  [ -e "$marker" ] && count=$((count + 1))
done

if [ "$count" -gt 0 ]; then
  # TTL backstops a killed session leaving a stale count; every change
  # refreshes it.
  "$herdr_bin" pane report-metadata "$HERDR_PANE_ID" \
    --source user:claude-subagents \
    --agent claude \
    --token "subagents=$count" \
    --ttl-ms 21600000 >/dev/null 2>&1 || true
else
  "$herdr_bin" pane report-metadata "$HERDR_PANE_ID" \
    --source user:claude-subagents \
    --agent claude \
    --clear-token subagents >/dev/null 2>&1 || true
fi
exit 0
