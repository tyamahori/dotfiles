# shellcheck shell=bash
# Sourced by the Codex apply_patch hook adapters; not registered as a hook.
# patch_paths <patch-text> <op-regex>: print each unique file path named by a
# `*** <op>: <path>` header, quotes stripped. Callers choose the ops because
# lint cannot check a deleted file while the prose hook must forget it.
patch_paths() {
	local file
	while IFS= read -r file; do
		[ -n "$file" ] || continue
		case "$file" in
		\"*\") file=${file#\"}; file=${file%\"} ;;
		\'*\') file=${file#\'}; file=${file%\'} ;;
		esac
		printf '%s\n' "$file"
	done < <(printf '%s\n' "$1" | sed -nE "s/^\*\*\* ($2): (.*)\$/\2/p" | sort -u)
}
