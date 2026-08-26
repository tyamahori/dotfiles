#!/bin/bash
# PreToolUse captures the first lint result for each prose file in a session.
# PostToolUse records successfully edited files for the Stop hook.
set -euo pipefail

payload=$(cat)
event=$(jq -r '.hook_event_name // empty' <<<"$payload")
session_id=$(jq -r '.session_id // empty' <<<"$payload")
file=$(jq -r '.tool_input.file_path // empty' <<<"$payload")
cwd=$(jq -r '.cwd // "."' <<<"$payload")

[ -n "$session_id" ] && [ -n "$file" ] || exit 0
case "$file" in
  *.md|*.markdown|*.txt) ;;
  *) exit 0 ;;
esac
case "$file" in
  /*) ;;
  *) file="$cwd/$file" ;;
esac

cache_base=${XDG_CACHE_HOME:-$HOME/.cache}
session_key=$(printf '%s' "$session_id" | shasum -a 256 | cut -d ' ' -f 1)
file_key=$(printf '%s' "$file" | shasum -a 256 | cut -d ' ' -f 1)
cache_dir="$cache_base/claude/japanese-prose/$session_key"
baseline_dir="$cache_dir/baselines"
files_dir="$cache_dir/files"
baseline="$baseline_dir/$file_key.json"

mkdir -p "$baseline_dir" "$files_dir"

case "$event" in
  PreToolUse)
    [ ! -f "$baseline" ] || exit 0

    lock="$baseline_dir/$file_key.lock"
    mkdir "$lock" 2>/dev/null || exit 0
    trap 'rmdir "$lock" 2>/dev/null || true' EXIT

    tmp="$baseline.tmp.$$"
    if [ -f "$file" ]; then
      if ! "$HOME/dotfiles/scripts/japanese-prose-lint" "$file" >"$tmp"; then
        jq -n --arg file "$file" '{schemaVersion: 1, file: $file, findings: []}' >"$tmp"
      fi
    else
      jq -n --arg file "$file" '{schemaVersion: 1, file: $file, findings: []}' >"$tmp"
    fi
    mv "$tmp" "$baseline"
    ;;

  PostToolUse)
    printf '%s\n' "$file" >"$files_dir/$file_key"
    ;;
esac
