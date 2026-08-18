#!/usr/bin/env bash
# agent-usage-review の計測スナップショット。合計は ccusage、警告フラグ診断は raw JSONL。
# 出力は markdown 一枚。使い方: snapshot.sh [--days N]  (default 7)
set -u

case "$#" in
	0) DAYS=7 ;;
	2)
		if [ "$1" = "--days" ] && [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
			DAYS="$2"
		else
			echo "usage: snapshot.sh [--days N]  (N: positive integer)" >&2
			exit 2
		fi
		;;
	*)
		echo "usage: snapshot.sh [--days N]  (N: positive integer)" >&2
		exit 2
		;;
esac
if date -v-1d +%Y%m%d >/dev/null 2>&1; then
	SINCE=$(date -v-"$((DAYS - 1))"d +%Y%m%d)
	CUTOFF=$(date -v-"$((DAYS - 1))"d +%Y-%m-%d)
else
	SINCE=$(date -d "-$((DAYS - 1)) days" +%Y%m%d)
	CUTOFF=$(date -d "-$((DAYS - 1)) days" +%Y-%m-%d)
fi
if /bin/date -j -f "%Y-%m-%d %H:%M:%S" "$CUTOFF 00:00:00" +%s >/dev/null 2>&1; then
	CUTOFF_EPOCH=$(/bin/date -j -f "%Y-%m-%d %H:%M:%S" "$CUTOFF 00:00:00" +%s)
else
	CUTOFF_EPOCH=$(date -d "$CUTOFF 00:00:00" +%s)
fi
CUTOFF_MS="$((CUTOFF_EPOCH * 1000))"


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
	jq -rs --arg f "$(basename "$f" .jsonl)" --argjson cutoff_epoch "$CUTOFF_EPOCH" '
		def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
		def ctx: .message.usage
			| ((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0));
		. as $records
		| [$records[] | select(.type=="assistant" and .message.usage
			and (try (.timestamp | epoch) catch 0) >= $cutoff_epoch)]
			| unique_by(.message.id) | sort_by(.timestamp) as $a
		| [$records[] | select(.type=="user"
			and (.origin.kind=="human" or .promptSource=="typed")
			and (try (.timestamp | epoch) catch 0) >= $cutoff_epoch)] as $human
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
	jq -rs --arg f "$(basename "$f" .jsonl)" --argjson cutoff_epoch "$CUTOFF_EPOCH" '
		def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
		[.[] | select(.type=="event_msg" and .payload.type=="token_count"
			and (try (.timestamp | epoch) catch 0) >= $cutoff_epoch)
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


echo
echo "## OMP 改善診断"
echo
echo '> 集計期間は上記と同じ '"${CUTOFF}"' 以降（ローカル日付境界を含む）。利用量は `~/.omp/stats.db` の正規化済み記録を使い、raw JSONL を再集計しない。compaction / handoff / prewalk は同DBにないため、`~/.omp/agent/sessions` のイベントIDを重複排除して数える。'
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
OMP_STATS="$HOME/.omp/stats.db"
OMP_SESSIONS="$HOME/.omp/agent/sessions"
OMP_CONFIG="$HOME/.omp/agent/config.yml"
CANONICAL_CONFIG="$REPO_ROOT/omp/config.yml"



omp_event_ids() {
	local kind="$1"
	find "$OMP_SESSIONS" -name '*.jsonl' -newermt "$CUTOFF" -print0 2>/dev/null |
		while IFS= read -r -d '' file; do
			jq -r --argjson cutoff_epoch "$CUTOFF_EPOCH" --arg kind "$kind" '
				def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
				select((try (.timestamp | epoch) catch 0) >= $cutoff_epoch)
				| select(
					($kind == "compaction" and .type == "compaction")
					or ($kind == "handoff" and .type == "custom_message" and .customType == "handoff")
					or ($kind == "prewalk" and .type == "custom_message" and .customType == "prewalk-continue")
				)
				| .id // empty
			' "$file" 2>/dev/null
		done | sort -u
}

if [ ! -f "$OMP_STATS" ] || ! command -v sqlite3 >/dev/null 2>&1; then
	echo '- **利用・長大セッション・cache churn・tool error:** 取得不能（必要な `~/.omp/stats.db` または `sqlite3` がない）。'
else
	echo "### モデル × agent type"
	echo
	echo 'model	agent_type	calls	sessions	cache_read	cache_write	output	cost'
	OMP_MODELS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT model, agent_type, COUNT(*), COUNT(DISTINCT session_file),
			       SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(output_tokens),
			       ROUND(SUM(cost_total), 2)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS
			GROUP BY model, agent_type
			ORDER BY SUM(cache_read_tokens) + SUM(cache_write_tokens) DESC;
		" 2>/dev/null
	)"
	if [ -n "$OMP_MODELS" ]; then
		printf '%s\n' "$OMP_MODELS"
	else
		echo "(対象期間に完了記録なし)"
	fi

	echo
	echo "### 長大 main / subagent セッション"
	echo
	echo '> session_file はローカル調査用で、skillのjournal以外へ保存しない。閾値: 累計 tokens 500k または 50 calls。'
	echo
	echo 'session_file	role	calls	total_tokens	cache_write'
	OMP_LONG_SESSIONS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT session_file, agent_type, COUNT(*), SUM(total_tokens), SUM(cache_write_tokens)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS
			GROUP BY session_file, agent_type
			HAVING SUM(total_tokens) >= 500000 OR COUNT(*) >= 50
			ORDER BY SUM(total_tokens) DESC
			LIMIT 8;
		" 2>/dev/null
	)"
	if [ -n "$OMP_LONG_SESSIONS" ]; then
		printf '%s\n' "$OMP_LONG_SESSIONS"
	else
		echo "(該当なし)"
	fi

	echo
	echo "### Cache churn と tool error"
	echo
	OMP_CHURN="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT COALESCE(SUM(cache_write_tokens), 0),
			       COALESCE(SUM(CASE WHEN cache_write_tokens > 50000 THEN cache_write_tokens ELSE 0 END), 0)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS;
		" 2>/dev/null
	)"
	if [ -n "$OMP_CHURN" ]; then
		IFS=$'\t' read -r OMP_CACHE_WRITE OMP_LARGE_CACHE_WRITE <<<"$OMP_CHURN"
		if [ "$OMP_CACHE_WRITE" -gt 0 ]; then
			OMP_CHURN_RATE="$(( OMP_LARGE_CACHE_WRITE * 100 / OMP_CACHE_WRITE ))"
			echo "- cacheWrite >50k の応答: ${OMP_LARGE_CACHE_WRITE}/${OMP_CACHE_WRITE} tokens (${OMP_CHURN_RATE}%)。既存 \`agent-usage\` と同じ >50k 閾値で、compaction 後の再キャッシュ候補を示す。"
		else
			echo "- cacheWrite: 0 tokens（churn 判定不能ではなく、対象期間に記録なし）。"
		fi
	else
		echo "- cache churn: 取得不能（stats.db の照会に失敗）。"
	fi
	echo
	echo 'tool	agent_type	errors	calls'
	OMP_TOOL_ERRORS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT tool_name, agent_type, SUM(CASE WHEN is_error THEN 1 ELSE 0 END), COUNT(*)
			FROM tool_calls
			WHERE timestamp >= $CUTOFF_MS
			GROUP BY tool_name, agent_type
			HAVING SUM(CASE WHEN is_error THEN 1 ELSE 0 END) > 0
			ORDER BY SUM(CASE WHEN is_error THEN 1 ELSE 0 END) DESC
			LIMIT 8;
		" 2>/dev/null
	)"
	if [ -n "$OMP_TOOL_ERRORS" ]; then
		printf '%s\n' "$OMP_TOOL_ERRORS"
	else
		echo "(tool error 記録なし)"
	fi

	echo
	echo "### prewalk とローカル tiny model"
	echo
	TINY_MODEL="$(sed -n 's/^[[:space:]]*tinyModel:[[:space:]]*//p' "$OMP_CONFIG" 2>/dev/null | sed -n '1p')"
	OMP_LOCAL_CALLS="$(
		sqlite3 -noheader "$OMP_STATS" "
			SELECT COUNT(*)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS
			  AND (lower(model) LIKE '%lfm%' OR lower(provider) IN ('local', 'ollama'));
		" 2>/dev/null
	)"
	if [ -n "$TINY_MODEL" ] && [ -n "$OMP_LOCAL_CALLS" ]; then
		echo "- configured tiny model: \`$TINY_MODEL\`; 完了記録: $OMP_LOCAL_CALLS calls。判定用だけのローカル呼出は messages に残らない場合がある。"
	else
		echo "- local tiny model: 取得不能（\`$OMP_CONFIG\` または stats.db の記録がない）。"
	fi
fi

echo
echo "### Compaction / handoff / prewalk イベント"
echo
if [ -d "$OMP_SESSIONS" ]; then
	OMP_COMPACTIONS="$(omp_event_ids compaction | wc -l | tr -d ' ')"
	OMP_HANDOFFS="$(omp_event_ids handoff | wc -l | tr -d ' ')"
	OMP_PREWALKS="$(omp_event_ids prewalk | wc -l | tr -d ' ')"
	echo "- compaction: $OMP_COMPACTIONS / handoff: $OMP_HANDOFFS / prewalk continue: $OMP_PREWALKS"
	echo "- event source: \`~/.omp/agent/sessions\`（本文・prompt・session ID は出力しない）。"
else
	echo "- 取得不能: \`$OMP_SESSIONS\` がない。"
fi

echo
echo "### Plugin / config drift"
echo
if [ -f "$OMP_CONFIG" ] && [ -f "$CANONICAL_CONFIG" ]; then
	if cmp -s "$OMP_CONFIG" "$CANONICAL_CONFIG"; then
		echo "- config.yml: canonical と一致"
	else
		echo "- config.yml: **drift**（\`$OMP_CONFIG\` と \`$CANONICAL_CONFIG\` を比較して確認）"
	fi
else
	echo "- config.yml: 取得不能（local または canonical file がない）"
fi

if command -v omp >/dev/null 2>&1 && [ -f "$REPO_ROOT/scripts/omp-plugins" ]; then
	OMP_PLUGINS="$(omp plugin list --json 2>/dev/null)"
	if [ -n "$OMP_PLUGINS" ] && jq -e '.npm | type == "array"' >/dev/null 2>&1 <<<"$OMP_PLUGINS"; then
		PLUGIN_DRIFT=""
		while IFS=$'\t' read -r plugin expected; do
			installed="$(jq -r --arg plugin "$plugin" '.npm[] | select(.name == $plugin) | .version' <<<"$OMP_PLUGINS")"
			if [ "$installed" != "$expected" ]; then
				PLUGIN_DRIFT="${PLUGIN_DRIFT}${PLUGIN_DRIFT:+, }${plugin} (expected ${expected}, installed ${installed:-(absent)})"
			fi
		done < <(sed -n '/^plugins=(/,/^)/s/^[[:space:]]*"\([^ ]*\) \([^"]*\)".*/\1\t\2/p' "$REPO_ROOT/scripts/omp-plugins")
		if [ -n "$PLUGIN_DRIFT" ]; then
			echo "- plugins: **drift** — $PLUGIN_DRIFT"
		else
			echo "- plugins: declared versions と一致"
		fi
	else
		echo "- plugins: 取得不能（\`omp plugin list --json\` が利用不可）"
	fi
else
	echo "- plugins: 取得不能（omp または canonical installer がない）"
fi

echo
echo "### 制約"
echo
echo '- `stats.db` は完了した model 呼出と tool 実行の索引であり、未完了・判定専用の local tiny 呼出は記録されないことがある。'
echo "- compaction / handoff / prewalk は JSONL の明示イベントのみを数える。イベントを出さない経路は取得不能で、0 と区別できない。"
echo "- この snapshot は計測と drift 検出だけを行い、設定・plugin・セッションを変更しない。"
