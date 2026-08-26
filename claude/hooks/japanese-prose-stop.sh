#!/bin/bash
# Stop hook: compare edited Japanese prose with its pre-edit lint baseline.
# A new finding set is returned once. An unchanged second Stop is allowed so
# contextually justified wording cannot create an infinite rewrite loop.
set -euo pipefail

payload=$(cat)
session_id=$(jq -r '.session_id // empty' <<<"$payload")
[ -n "$session_id" ] || exit 0

cache_base=${XDG_CACHE_HOME:-$HOME/.cache}
session_key=$(printf '%s' "$session_id" | shasum -a 256 | cut -d ' ' -f 1)
cache_dir="$cache_base/claude/japanese-prose/$session_key"
baseline_dir="$cache_dir/baselines"
files_dir="$cache_dir/files"
reported_digest="$cache_dir/reported-digest"
[ -d "$files_dir" ] || exit 0

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
results_dir="$tmp_dir/results"
mkdir -p "$results_dir"
result_count=0

for path_file in "$files_dir"/*; do
  [ -f "$path_file" ] || continue
  file=$(cat "$path_file")
  [ -f "$file" ] || continue

  file_key=$(basename "$path_file")
  baseline="$baseline_dir/$file_key.json"
  current="$tmp_dir/current-$file_key.json"
  current_stderr="$tmp_dir/current-$file_key.stderr"

  if ! "$HOME/dotfiles/scripts/japanese-prose-lint" "$file" >"$current" 2>"$current_stderr"; then
    error=$(cat "$current_stderr")
    jq -n \
      --arg file "$file" \
      --arg message "$error" \
      '{
        schemaVersion: 1,
        file: $file,
        findings: [{
          source: "hook",
          ruleId: "lint-error",
          severity: "critical",
          line: 1,
          column: null,
          message: $message,
          excerpt: null,
          fingerprint: ("hook\u0000lint-error\u0000" + $message)
        }]
      }' >"$current"
  fi

  if [ ! -f "$baseline" ]; then
    baseline="$tmp_dir/baseline-$file_key.json"
    jq -n --arg file "$file" '{schemaVersion: 1, file: $file, findings: []}' >"$baseline"
  fi

  result_count=$((result_count + 1))
  jq -n \
    --arg file "$file" \
    --slurpfile baseline "$baseline" \
    --slurpfile current "$current" '
      ($baseline[0].findings
       | group_by(.fingerprint)
       | map({key: .[0].fingerprint, value: length})
       | from_entries) as $baseline_counts
      | reduce $current[0].findings[] as $finding (
          {used: {}, findings: []};
          ($finding.fingerprint) as $key
          | .used[$key] = ((.used[$key] // 0) + 1)
          | if .used[$key] > ($baseline_counts[$key] // 0)
            then .findings += [$finding + {file: $file}]
            else .
            end
        )
      | {file: $file, findings: .findings}
    ' >"$results_dir/$file_key.json"
done

if [ "$result_count" -eq 0 ]; then
  rm -rf "$cache_dir"
  exit 0
fi

aggregate="$tmp_dir/aggregate.json"
jq -s '{findings: [.[].findings[]]}' "$results_dir"/*.json >"$aggregate"
count=$(jq '.findings | length' "$aggregate")

if [ "$count" -eq 0 ]; then
  rm -rf "$cache_dir"
  exit 0
fi

canonical=$(jq -cS '[.findings[] | {file, fingerprint, line, column, message}] | sort_by(.file, .fingerprint, .line, .column)' "$aggregate")
digest=$(printf '%s' "$canonical" | shasum -a 256 | cut -d ' ' -f 1)

if [ -f "$reported_digest" ] && [ "$(cat "$reported_digest")" = "$digest" ]; then
  rm -rf "$cache_dir"
  exit 0
fi
printf '%s\n' "$digest" >"$reported_digest"

summary=$(jq -r '
  .findings[:20]
  | map(
      "\(.file):\(.line // 1)" +
      (if .column then ":\(.column)" else "" end) + "\n" +
      "- [\(.source)/\(.ruleId)] \(.message)" +
      (if .excerpt then "\n  該当箇所: \(.excerpt)" else "" end)
    )
  | join("\n\n")
' "$aggregate")

if [ "$count" -gt 20 ]; then
  summary="$summary

ほか $((count - 20)) 件"
fi

reason="編集前の状態と比べて、日本語文章に新しい指摘が $count 件あります。

$summary

文脈に照らして修正してください。意味や正確性を損なう指摘は残して構いません。同じ内容で再度終了した場合は、確認済みとして通過します。"

jq -n --arg reason "${reason:0:12000}" '{decision: "block", reason: $reason}'
