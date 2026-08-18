#!/usr/bin/env bash
# agent-usage-review の計測スナップショット。合計は ccusage、赤旗診断は raw JSONL。
# 出力は markdown 一枚。使い方: snapshot.sh [--days N]  (default 7)
set -u

DAYS=7
[ "${1:-}" = "--days" ] && DAYS="${2:-7}"
if date -v-1d +%Y%m%d >/dev/null 2>&1; then
	SINCE=$(date -v-"$((DAYS - 1))"d +%Y%m%d)
	CUTOFF=$(date -v-"$((DAYS - 1))"d +%Y-%m-%d)
else
	SINCE=$(date -d "-$((DAYS - 1)) days" +%Y%m%d)
	CUTOFF=$(date -d "-$((DAYS - 1)) days" +%Y-%m-%d)
fi

CCUSAGE="npx -y ccusage@latest"

echo "# usage snapshot ${SINCE}..$(date +%Y%m%d)"
echo
echo "## 日次合計 (agent 別)"
echo
$CCUSAGE daily --since "$SINCE" --json 2>/dev/null | jq -r '
	.daily[]
	| .period as $d
	| .modelBreakdowns // [] | .
	| map("\($d)\t\(.modelName // "?")\t\(.inputTokens + .outputTokens + .cacheCreationTokens + .cacheReadTokens)\t$\(.cost * 100 | round / 100)")
	| .[]' 2>/dev/null ||
	$CCUSAGE daily --since "$SINCE" 2>/dev/null | grep -v '^\s*$'

echo
echo "## コスト上位セッション"
echo
$CCUSAGE session --since "$SINCE" --json 2>/dev/null | jq -r '
	.session
	| sort_by(-.totalCost) | .[0:8][]
	| "\(.agent)\t\(.period)\tcacheR=\(.cacheReadTokens)\tcacheW=\(.cacheCreationTokens)\tout=\(.outputTokens)\t$\(.totalCost * 100 | round / 100)"'

echo
echo "## 赤旗: Claude セッション"
echo "# 基準: 日跨ぎ(days>1) / cache 書き込み>1M (context churn) / 20k 字超の user メッセージ (インライン貼り付け)"
echo
find "$HOME/.claude/projects" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" --arg cutoff "$CUTOFF" '
		[.[] | select(.type=="assistant" and .message.usage)] as $a
		| ([.[] | .timestamp // empty] | map(.[0:10])) as $ts
		# mtime は resume や索引更新でずれるので、期間内のイベントがあるセッションだけ診る
		| select(($ts | max // "") >= $cutoff)
		| ($ts | unique | length) as $days
		| ([$a[].message.usage.cache_creation_input_tokens // 0] | add // 0) as $cw
		| ([.[] | select(.type=="user" and (.isMeta != true))
			| .message.content
			| if type=="string" then length
			  elif type=="array" then ([.[]? | .text? // "" | length] | add // 0)
			  else 0 end
			| select(. > 20000)] | length) as $big
		| select($days > 1 or $cw > 1000000 or $big > 0)
		| "\($f)\tdays=\($days)\tcacheW=\($cw)\tbig_user_msgs=\($big)\tturns=\($a | length)"
	' "$f" 2>/dev/null
done

echo
echo "## 赤旗: Codex セッション"
echo "# 基準: cache hit < 70% (input>100k) / 最終コンテキスト > 200k"
echo
find "$HOME/.codex/sessions" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" '
		[.[] | select(.type=="event_msg" and .payload.type=="token_count")
		 | .payload.info.last_token_usage | select(. != null)] as $t
		| select(($t | length) > 0)
		| ([$t[].input_tokens] | add) as $in
		| ([$t[].cached_input_tokens] | add) as $cached
		| ($t[-1].total_tokens) as $ctx
		| (if $in > 0 then $cached / $in else 1 end) as $hit
		| select(($in > 100000 and $hit < 0.7) or $ctx > 200000)
		| "\($f)\tin=\($in)\thit=\($hit * 100 | round)%\tfinal_ctx=\($ctx)"
	' "$f" 2>/dev/null
done

echo
echo "(赤旗ゼロの節は空 = 問題なし)"
