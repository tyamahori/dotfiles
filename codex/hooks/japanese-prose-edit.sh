#!/bin/bash
# Translate Codex apply_patch hook payloads into the shared prose hook format.
set -euo pipefail

payload=$(cat)
event=$(jq -r '.hook_event_name // empty' <<<"$payload")
session_id=$(jq -r '.session_id // empty' <<<"$payload")
cwd=$(jq -r '.cwd // "."' <<<"$payload")
tool_name=$(jq -r '.tool_name // empty' <<<"$payload")
command=$(jq -r '.tool_input.command // empty' <<<"$payload")

[ -n "$session_id" ] && [ "$tool_name" = "apply_patch" ] || exit 0
case "$event" in
  PreToolUse|PostToolUse) ;;
  *) exit 0 ;;
esac

# shellcheck disable=SC1091 # patch-paths.sh is linted on its own
. "$(dirname "$0")/patch-paths.sh"

while IFS= read -r file; do
	jq -n \
		--arg event "$event" \
		--arg session_id "$session_id" \
		--arg cwd "$cwd" \
		--arg file "$file" \
		'{hook_event_name: $event, session_id: $session_id, cwd: $cwd, tool_input: {file_path: $file}}' |
		JAPANESE_PROSE_RUNTIME=codex "$HOME/dotfiles/scripts/japanese-prose-hook-edit"
done < <(patch_paths "$command" 'Update File|Add File|Delete File|Move to')
