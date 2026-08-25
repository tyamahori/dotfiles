#!/usr/bin/env bash
# worktree.created hook. First copy the gitignored files selected by the source
# repository's .worktreeinclude. Then, when a same-named remote branch exists,
# set it as upstream and — only for a branch herdr just minted (single "Created
# from" reflog entry, clean tree) — hard-reset onto the remote tip so the
# worktree follows the remote branch instead of forking from HEAD.
# Every failure or skip path exits 0: this hook must never make worktree
# creation look failed.
set -u

ev="${HERDR_PLUGIN_EVENT_JSON:-}"
[ -n "$ev" ] || exit 0
path=$(printf '%s' "$ev" | jq -r '.data.workspace.worktree.checkout_path // .data.worktree.path // empty' 2>/dev/null)
source_root=$(printf '%s' "$ev" | jq -r '.data.workspace.worktree.repo_root // .data.worktree.repo_root // empty' 2>/dev/null)
[ -n "$path" ] && [ -d "$path" ] || exit 0
if [ -z "$source_root" ]; then
	common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
	case "$common_dir" in
	*/.git) source_root="${common_dir%/.git}" ;;
	esac
fi

if [ -n "$source_root" ] && [ "$source_root" != "$path" ]; then
	plugin_dir=$(cd "$(dirname "$0")" && pwd)
	helper="$plugin_dir/../../../scripts/worktree-include-copy"
	if [ -x "$helper" ]; then
		"$helper" "$source_root" "$path" || true
	fi
fi

cd "$path" || exit 0

branch=$(git symbolic-ref --short -q HEAD) || exit 0 # detached: nothing to track
git rev-parse -q --verify "$branch@{upstream}" >/dev/null 2>&1 && exit 0

remote=$(git config "branch.$branch.remote" 2>/dev/null || true)
if [ -z "$remote" ]; then
	if git remote | grep -qx origin; then
		remote=origin
	else
		remote=$(git remote | head -n1)
	fi
fi
[ -n "$remote" ] || exit 0

# One network call: fetch fails when the branch is absent remotely (or offline),
# and updates refs/remotes/<remote>/<branch> when it succeeds.
git fetch --quiet "$remote" "$branch" >/dev/null 2>&1 || exit 0
git rev-parse -q --verify "refs/remotes/$remote/$branch" >/dev/null || exit 0

git branch --set-upstream-to="$remote/$branch" "$branch" >/dev/null 2>&1 || exit 0

# Reset only a branch herdr just created; a reused local branch may hold
# unpushed work and must keep its tip (upstream alone is enough there).
entries=$(git reflog show --format=%gs "refs/heads/$branch" 2>/dev/null || true)
if [ -n "$entries" ] &&
	[ "$(printf '%s\n' "$entries" | wc -l)" -eq 1 ] &&
	printf '%s' "$entries" | grep -q '^branch: Created from' &&
	[ -z "$(git status --porcelain)" ]; then
	git reset --hard --quiet "refs/remotes/$remote/$branch"
fi
exit 0
