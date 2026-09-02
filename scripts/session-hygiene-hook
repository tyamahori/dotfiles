#!/bin/bash
# SessionStart hook: mechanize the session-hygiene rules from
# agents/global-instructions.md. Two triggers:
#   - source=compact: from the second compaction of a session onward, tell the
#     agent to write a handoff note and wind down (every further turn rewrites
#     the whole context as cache writes).
#   - source=resume: warn on day-crossing resumes always, and on large
#     transcripts resumed after more than an hour idle (measured 2026-08-19: a
#     2h17m same-day resume reprocessed 3.07M context tokens over 10 turns).
# Warnings are injected as additionalContext; the hook never blocks.
set -euo pipefail

payload=$(cat)
source=$(jq -r '.source // empty' <<<"$payload")

warn() {
	jq -n --arg ctx "$1" \
		'{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
	exit 0
}

case "$source" in
compact)
	session_id=$(jq -r '.session_id // empty' <<<"$payload")
	[ -n "$session_id" ] || exit 0
	dir=${XDG_CACHE_HOME:-$HOME/.cache}/agent-session-hygiene
	mkdir -p "$dir"
	key=$(printf '%s' "$session_id" | shasum -a 256 | cut -d ' ' -f 1)
	count_file="$dir/$key.compactions"
	count=$(($(cat "$count_file" 2>/dev/null || echo 0) + 1))
	printf '%s' "$count" >"$count_file"
	if [ "$count" -ge 2 ]; then
		warn "[session-hygiene] This session has now compacted $count times. Per the session-hygiene rules, repeated compaction means stop now: write a durable handoff note (repository-defined location, else .agent-msgs/handoff/YYYY-MM-DD-<topic>.md), then tell the user to /quit and start a fresh session. Do not continue long work here."
	fi
	;;
resume)
	transcript=$(jq -r '.transcript_path // empty' <<<"$payload")
	[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
	mtime=$(stat -f %m "$transcript" 2>/dev/null || stat -c %Y "$transcript" 2>/dev/null) || exit 0
	size=$(stat -f %z "$transcript" 2>/dev/null || stat -c %s "$transcript" 2>/dev/null) || size=0
	now=$(date +%s)
	idle=$((now - mtime))
	last_day=$(date -r "$mtime" +%Y-%m-%d 2>/dev/null || date -d "@$mtime" +%Y-%m-%d)
	today=$(date +%Y-%m-%d)
	if [ "$last_day" != "$today" ]; then
		warn "[session-hygiene] This resume crosses a day boundary (last activity $last_day). Per the session-hygiene rules, sessions are not resumed across days: write a durable handoff note, then recommend the user quit and start a fresh session with that note instead of continuing here."
	fi
	# Transcript size is a proxy for context size; 5MB JSONL roughly marks the
	# large-context sessions the >200k rule targets.
	if [ "$idle" -gt 3600 ] && [ "$size" -gt 5000000 ]; then
		warn "[session-hygiene] Resuming a large transcript (~$((size / 1000000))MB) after more than an hour idle re-reads the whole context. Recommend writing a handoff note and starting fresh unless the remaining work here is short."
	fi
	;;
esac
exit 0
