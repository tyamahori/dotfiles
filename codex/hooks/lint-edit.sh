#!/bin/bash
# Translate Codex apply_patch PostToolUse payloads into the shared lint hook
# (scripts/lint-on-edit: shellcheck / ruff / actionlint). Emits at most one
# block decision per tool call so Codex gets a single actionable reason.
set -euo pipefail

payload=$(cat)
event=$(jq -r '.hook_event_name // empty' <<<"$payload")
tool_name=$(jq -r '.tool_name // empty' <<<"$payload")
cwd=$(jq -r '.cwd // "."' <<<"$payload")
command=$(jq -r '.tool_input.command // empty' <<<"$payload")

[ "$event" = "PostToolUse" ] && [ "$tool_name" = "apply_patch" ] || exit 0

while IFS= read -r file; do
	[ -n "$file" ] || continue
	case "$file" in
	\"*\") file=${file#\"}; file=${file%\"} ;;
	\'*\') file=${file#\'}; file=${file%\'} ;;
	esac
	case "$file" in
	/*) ;;
	*) file="$cwd/$file" ;;
	esac
	result=$(jq -n --arg file "$file" '{tool_input: {file_path: $file}}' |
		"$HOME/dotfiles/scripts/lint-on-edit")
	if [ -n "$result" ]; then
		printf '%s\n' "$result"
		exit 0
	fi
done < <(
	printf '%s\n' "$command" |
		sed -nE 's/^\*\*\* (Update File|Add File|Move to): (.*)$/\2/p' |
		sort -u
)
exit 0
