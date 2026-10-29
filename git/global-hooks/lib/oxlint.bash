# shellcheck shell=bash
# Sourced by scripts/lint-on-edit and checks/pre-commit-oxlint, after
# lib/baseline.bash, so edit time and commit time judge TS/JS the same way.
#
# A repository whose team defined lint rules (an oxlint, ESLint, or Biome
# config anywhere in the tree) keeps them: oxlint runs with the repository's
# own .oxlintrc.json, or with oxlint's correctness defaults when the team lints
# with another tool. Every other repository gets the readability rules in this
# dotfiles' .oxlintrc.json.

OXLINT_DOTFILES_CONFIG=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)/.oxlintrc.json

# oxlint_setup: run in the repo root. Sets OXLINT_ARGS, and BASELINE_EXTRA to
# the repository's oxlint configs so HEAD is linted under HEAD's rules.
oxlint_setup() {
	local team f
	team=$(git ls-files -- ':(glob)**/.oxlintrc.json' ':(glob)**/oxlint.config.ts' ':(glob)**/eslint.config.*' ':(glob)**/.eslintrc*' ':(glob)**/biome.json' ':(glob)**/biome.jsonc') || return 1
	OXLINT_ARGS=()
	BASELINE_EXTRA=()
	if [[ -z $team ]]; then
		OXLINT_ARGS=(-c "$OXLINT_DOTFILES_CONFIG")
		return 0
	fi
	while IFS= read -r f; do
		case "${f##*/}" in .oxlintrc.json | oxlint.config.ts) BASELINE_EXTRA+=("$f") ;; esac
	done <<<"$team"
}

# oxlint_rows FILE...: baseline rows (lib/baseline.bash). The position is the
# first line of the flagged node (a function's header for complexity and size
# rules), so editing inside a legacy function does not count as touching its
# finding. Numbers in the key are masked: a complexity that moves from 12 to
# 11 is the same finding.
oxlint_rows() (
	rc=0
	out=$(oxlint ${OXLINT_ARGS[@]+"${OXLINT_ARGS[@]}"} --format=json -- "$@" 2>&1) || rc=$?
	# Every file given matched an ignore pattern: oxlint prints this line before
	# an empty report and exits 1. Only this exact line is dropped, so no other
	# text can turn a failure into an empty, clean report.
	out=${out#"No files found to lint. Please check your paths and ignore patterns."$'\n'}
	if ((rc <= 1)) && [[ -n $out ]] && rows=$(jq -r '.diagnostics[] |
		((.labels[0].span.line // "-") | tostring) as $l |
		(.message | gsub("[\t\r\n]+"; " ")) as $m |
		[.filename, $l, $l, "\(.code) \($m | gsub("[0-9]+"; "N"))", "\(.filename):\($l) \($m) [\(.code)]"] | @tsv' <<<"$out" 2>/dev/null); then
		[[ -z $rows ]] && exit 0
		printf '%s\n' "$rows"
		exit 1
	fi
	printf '%s\n' "$out"
	exit 2
)
