# Sourced by the pre-commit checks that lint whole files (semgrep, zizmor,
# dclint, hadolint, sqruff, the Compose checks). A staged file with a
# violation the commit did not touch must not block the commit, while a
# violation the commit adds must. Rather than every tool's own baseline
# mechanism (zizmor has none, semgrep's --baseline-commit checks HEAD out
# into the working tree mid-commit, and a repo's own baseline file is no
# portable format), the finding sets of the staged files and of the same
# files in HEAD are compared.
#
# baseline_check ROWS_FN FILE...
#   ROWS_FN FILE... runs the tool in the current directory (the repo root, or
#   a snapshot of HEAD) and prints one finding per line as five tab-separated
#   fields: FILE START END KEY DESC. START and END are the finding's 1-based
#   inclusive line range, or `-` for both when the tool reports no position.
#   KEY identifies the rule and message (never a position); the text of the
#   flagged lines is appended to it here. DESC is shown when the finding
#   blocks. Exit status: 0 clean, 1 findings, anything else tool failure.
#   Anything that is not a recognized finding row (a tool failure, an invalid
#   config, a missing dependency) must come back as a failure, never as a row:
#   rows are compared between HEAD and the working tree and equal rows cancel.
#
#   A finding blocks when EITHER its line range overlaps a line the commit
#   adds (a moved or rewritten flagged line is an added line), OR the staged
#   files have more findings with its FILE and KEY than HEAD (so findings on
#   unchanged lines that a deletion or context change created still block, and
#   so do tools without positions). Every step that cannot complete (temp dir,
#   HEAD extraction, diff, tool failure, unparseable rows) blocks.
#   BASELINE_EXTRA (array, optional) lists more pathspecs to take from HEAD,
#   such as tool config.
# Residual: a renamed file has no HEAD counterpart, so all its findings count
# as new; a tool without positions cannot tell one finding from a replacement
# with the same FILE and KEY.

# baseline_rows ROOT FN FILE...: run FN in ROOT. Status 0 clean; 1 findings,
# printed normalized (FILE START END KEY+source DESC); otherwise the raw
# output, status 2.
baseline_rows() {
	local root=$1 fn=$2 out norm rc=0
	shift 2
	out=$(
		cd "$root" || exit 2
		"$fn" "$@"
	) || rc=$?
	((rc == 0)) && return 0
	if ((rc == 1)); then
		# Normalize with the scanned files at hand: they supply the flagged text.
		if norm=$(
			cd "$root" || exit 2
			printf '%s\n' "$out" | awk -F'\t' -v OFS='\t' '
				function src(f, s, e,   i, l, t) {
					if (!(f in n)) {
						n[f] = 0
						while ((getline l < f) > 0) lines[f, ++n[f]] = l
						close(f)
					}
					for (i = s; i <= e && i <= n[f]; i++) {
						l = lines[f, i]
						gsub(/[ \t\r]+/, " ", l)
						t = t l
					}
					return t
				}
				{
					ok = NF == 5 && $1 != "" && (($2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/) || ($2 == "-" && $3 == "-"))
					if (!ok) { bad = 1; exit }
					k = $4
					if ($2 != "-") k = k "\001" src($1, $2 + 0, $3 + 0)
					print $1, $2, $3, k, $5
					rows++
				}
				END { exit (bad || !rows) }
			'
		); then
			printf '%s\n' "$norm"
			return 1
		fi
		printf 'unrecognized tool output:\n%s\n' "$out"
		return 2
	fi
	printf '%s\n' "$out"
	return 2
}

# baseline_added FILE...: FILE START END for every line the working tree adds
# relative to HEAD.
baseline_added() {
	local f diff
	for f in "$@"; do
		diff=$(git --literal-pathspecs diff HEAD -U0 --no-color --no-renames --no-ext-diff --no-textconv -- "$f") || return 1
		printf '%s\n' "$diff" |
			awk -v f="$f" '
				/^@@ / {
					for (i = 1; i <= NF; i++) if ($i ~ /^\+[0-9]/) break
					split(substr($i, 2), a, ",")
					c = a[1] + 0
					d = (a[2] == "" ? 1 : a[2] + 0)
					if (d > 0) printf "%s\t%d\t%d\n", f, c, c + d - 1
				}' || return 1
	done
}

# baseline_snapshot DEST FILE...: write the HEAD blobs of FILE... and of
# BASELINE_EXTRA into DEST and set BASELINE_HEAD_FILES to the FILE... that HEAD
# has. A scratch index extracts the blobs themselves: unlike git archive it
# ignores .gitattributes export-ignore, and one process covers a whole tree.
baseline_snapshot() {
	local dest=$1 list=$BASELINE_TMP/ls f
	shift
	BASELINE_HEAD_FILES=()
	mkdir "$dest" || return 1
	git --literal-pathspecs ls-tree -r -z --name-only HEAD -- "$@" ${BASELINE_EXTRA[@]+"${BASELINE_EXTRA[@]}"} >"$list" || return 1
	GIT_INDEX_FILE=$BASELINE_TMP/index git read-tree HEAD || return 1
	GIT_INDEX_FILE=$BASELINE_TMP/index git checkout-index -z --stdin --prefix="$dest/" <"$list" || return 1
	for f in "$@"; do
		[[ -e $dest/$f || -L $dest/$f ]] && BASELINE_HEAD_FILES+=("$f")
	done
	return 0
}

baseline_compare() {
	local fn=$1 rc=0 head_rc=0 staged head_rows='' new
	shift
	staged=$(baseline_rows . "$fn" "$@") || rc=$?
	((rc == 0)) && return 0
	if ((rc != 1)); then
		printf '%s\n' "$staged" >&2
		return 1
	fi
	# Cleanup is armed right after allocation, so no failure below can leak it.
	BASELINE_TMP=$(mktemp -d) || { echo "pre-commit: cannot create a temporary directory; blocking." >&2; return 1; }
	trap 'rm -rf "$BASELINE_TMP"' EXIT
	if git rev-parse -q --verify HEAD >/dev/null; then
		baseline_added "$@" >"$BASELINE_TMP/added" || { echo "pre-commit: cannot read the staged diff; blocking." >&2; return 1; }
		baseline_snapshot "$BASELINE_TMP/head" "$@" || { echo "pre-commit: cannot extract HEAD for the baseline; blocking." >&2; return 1; }
		if ((${#BASELINE_HEAD_FILES[@]})); then
			# A HEAD that the tool cannot lint gives no baseline: all findings stay new.
			head_rows=$(baseline_rows "$BASELINE_TMP/head" "$fn" "${BASELINE_HEAD_FILES[@]}") || head_rc=$?
			((head_rc == 1)) || head_rows=''
		fi
	else
		: >"$BASELINE_TMP/added"
	fi
	printf '%s\n' "$head_rows" >"$BASELINE_TMP/head.rows"
	printf '%s\n' "$staged" >"$BASELINE_TMP/staged.rows"
	new=$(awk -F'\t' -v a="$BASELINE_TMP/added" -v h="$BASELINE_TMP/head.rows" '
		FILENAME == a { n[$1]++; s[$1, n[$1]] = $2; e[$1, n[$1]] = $3; next }
		FILENAME == h { if (NF) seen[$1 FS $4]++; next }
		{
			new = 0
			if ($2 != "-") for (i = 1; i <= n[$1]; i++) if ($2 + 0 <= e[$1, i] + 0 && $3 + 0 >= s[$1, i] + 0) new = 1
			# Findings on added lines do not use up the HEAD count.
			if (!new && seen[$1 FS $4]-- <= 0) new = 1
			if (new) print $5
		}
	' "$BASELINE_TMP/added" "$BASELINE_TMP/head.rows" "$BASELINE_TMP/staged.rows") || { echo "pre-commit: cannot compare findings; blocking." >&2; return 1; }
	[[ -z $new ]] && return 0
	printf '%s\n' "$new" >&2
	return 1
}

baseline_check() {
	local rc=0
	BASELINE_TMP=
	baseline_compare "$@" || rc=$?
	[[ -n $BASELINE_TMP ]] && rm -rf "$BASELINE_TMP"
	trap - EXIT
	return "$rc"
}
