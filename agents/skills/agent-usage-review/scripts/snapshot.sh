#!/usr/bin/env bash
# agent-usage-review の計測スナップショット。合計は ccusage、警告フラグ診断は raw JSONL。
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
echo "## 警告フラグ: Claude セッション"
echo "# 基準: 人間の入力が日跨ぎ(days>1) / cache 書き込み>1M / 20k 字超の人間入力 / 最終context>200k / 1時間超のidle後に200k超contextを再開"
echo
find "$HOME/.claude/projects" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" --arg cutoff "$CUTOFF" '
		def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
		def ctx: .message.usage
			| ((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0));
		. as $records
		| [$records[] | select(.type=="assistant" and .message.usage
			and ((.timestamp // "")[0:10] >= $cutoff))]
			| unique_by(.message.id) | sort_by(.timestamp) as $a
		| [$records[] | select(.type=="user"
			and (.origin.kind=="human" or .promptSource=="typed")
			and ((.timestamp // "")[0:10] >= $cutoff))] as $human
		| select(($a | length) > 0)
		| ([$human[].timestamp[0:10]] | unique | length) as $days
		| ([$a[].message.usage.cache_creation_input_tokens // 0] | add // 0) as $cw
		| ([$human[]
			| .message.content
			| if type=="string" then length
			  elif type=="array" then ([.[]? | .text? // "" | length] | add // 0)
			  else 0 end
			| select(. > 20000)] | length) as $big
		| ($a[-1] | ctx) as $final
		| ([range(1; ($a | length)) as $i
			| select(
				(($a[$i].timestamp | epoch) - ($a[$i - 1].timestamp | epoch)) > 3600
				and ($a[$i] | ctx) > 200000
				and ($a[$i].message.usage.cache_creation_input_tokens // 0) > 100000
			)] | length) as $idle
		| select($days > 1 or $cw > 1000000 or $big > 0 or $final > 200000 or $idle > 0)
		| "\($f)\tdays=\($days)\tcacheW=\($cw)\tbig_user_msgs=\($big)\tturns=\($a | length)\tfinal_ctx=\($final)\tidle_resumes=\($idle)"
	' "$f" 2>/dev/null
done

echo
echo "## 警告フラグ: Codex セッション"
echo "# 基準: cache hit < 70% (input>100k) / 最終コンテキスト > 200k"
echo
find "$HOME/.codex/sessions" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" --arg cutoff "$CUTOFF" '
		[.[] | select(.type=="event_msg" and .payload.type=="token_count"
			and ((.timestamp // "")[0:10] >= $cutoff))
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
echo "(警告フラグゼロの節は空 = 問題なし)"
