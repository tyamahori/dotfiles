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

LOW_CACHE_MIN_INPUT=100000
LOW_CACHE_PERCENT=70
LARGE_TOOL_RESULT_SIZE=50000
CONTEXT_JUMP_TOKENS=50000
CONTEXT_PEAK_TOKENS=200000


CCUSAGE="npx -y ccusage@latest"

echo "# usage snapshot ${SINCE}..$(date +%Y%m%d)"
echo
echo "## 日次合計 (agent 別)"
echo
echo 'date	model	fresh_input	cache_read	cache_write	output	raw_total	cache_read_share	cost'
$CCUSAGE daily --since "$SINCE" --json 2>/dev/null | jq -r '
	.daily[]
	| .period as $d
	| .modelBreakdowns // [] | .
	| map(
		(.inputTokens // 0) as $fresh
		| (.cacheReadTokens // 0) as $cr
		| (.cacheCreationTokens // 0) as $cw
		| (.outputTokens // 0) as $out
		| ($fresh + $cr + $cw) as $seen
		| "\($d)\t\(.modelName // "?")\t\($fresh)\t\($cr)\t\($cw)\t\($out)\t\($seen + $out)\t\(if $seen > 0 then ($cr * 100 / $seen | round) else 0 end)%\t$\((.cost // 0) * 100 | round / 100)"
	)
	| .[]' 2>/dev/null ||
	$CCUSAGE daily --since "$SINCE" 2>/dev/null | grep -v '^\s*$'

echo
echo "## コスト上位セッション"
echo
echo 'agent	session	fresh_input	cache_read	cache_write	output	cache_read_share	cost'
$CCUSAGE session --since "$SINCE" --json 2>/dev/null | jq -r '
	.session
	| sort_by(-.totalCost) | .[0:8][]
	| (.inputTokens // 0) as $fresh
	| (.cacheReadTokens // 0) as $cr
	| (.cacheCreationTokens // 0) as $cw
	| ($fresh + $cr + $cw) as $seen
	| "\(.agent)\t\(.period)\t\($fresh)\t\($cr)\t\($cw)\t\(.outputTokens // 0)\t\(if $seen > 0 then ($cr * 100 / $seen | round) else 0 end)%\t$\((.totalCost // 0) * 100 | round / 100)"'

echo
echo "## 警告フラグ: Claude セッション"
echo "# 基準: 人間の入力が日跨ぎ(days>1) / cache 書き込み>1M / 20k 字超の人間入力 / cache read率<${LOW_CACHE_PERCENT}% (input>${LOW_CACHE_MIN_INPUT}) / 同一長大contextで複数model / 最終context>${CONTEXT_PEAK_TOKENS} / 1時間超のidle後に${CONTEXT_PEAK_TOKENS}超contextを再開"
echo
find "$HOME/.claude/projects" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" \
		--argjson cutoff_epoch "$CUTOFF_EPOCH" \
		--argjson cache_min "$LOW_CACHE_MIN_INPUT" \
		--argjson low_cache_percent "$LOW_CACHE_PERCENT" \
		--argjson context_peak "$CONTEXT_PEAK_TOKENS" '
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
		| ([$a[].message.usage.input_tokens // 0] | add // 0) as $fresh
		| ([$a[].message.usage.cache_read_input_tokens // 0] | add // 0) as $cr
		| ([$a[].message.usage.cache_creation_input_tokens // 0] | add // 0) as $cw
		| ($fresh + $cr + $cw) as $seen
		| (if $seen > 0 then $cr / $seen else 1 end) as $hit
		| ([$a[].message.model // "?"] | unique | length) as $models
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
				and ($a[$i] | ctx) > $context_peak
				and ($a[$i].message.usage.cache_creation_input_tokens // 0) > 100000
			)] | length) as $idle
		| select(
			$days > 1
			or $cw > 1000000
			or $big > 0
			or ($seen > $cache_min and ($hit * 100) < $low_cache_percent)
			or ($seen > $cache_min and $models > 1)
			or $final > $context_peak
			or $idle > 0
		)
		| "\($f)\tdays=\($days)\tfresh=\($fresh)\tcacheR=\($cr)\tcacheW=\($cw)\thit=\($hit * 100 | round)%\tmodels=\($models)\tbig_user_msgs=\($big)\tturns=\($a | length)\tfinal_ctx=\($final)\tidle_resumes=\($idle)"
	' "$f" 2>/dev/null
done

echo
echo "## 警告フラグ: Codex セッション"
echo "# 基準: cache hit < ${LOW_CACHE_PERCENT}% (input>${LOW_CACHE_MIN_INPUT}) / 最終コンテキスト > ${CONTEXT_PEAK_TOKENS}"
echo
find "$HOME/.codex/sessions" -name '*.jsonl' -newermt "$CUTOFF" 2>/dev/null | while IFS= read -r f; do
	jq -rs --arg f "$(basename "$f" .jsonl)" \
		--argjson cutoff_epoch "$CUTOFF_EPOCH" \
		--argjson cache_min "$LOW_CACHE_MIN_INPUT" \
		--argjson low_cache_percent "$LOW_CACHE_PERCENT" \
		--argjson context_peak "$CONTEXT_PEAK_TOKENS" '
		def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
		[.[] | select(.type=="event_msg" and .payload.type=="token_count"
			and (try (.timestamp | epoch) catch 0) >= $cutoff_epoch)
		 | .payload.info.last_token_usage | select(. != null)] as $t
		| select(($t | length) > 0)
		| ([$t[].input_tokens] | add) as $in
		| ([$t[].cached_input_tokens] | add) as $cached
		| ($t[-1].total_tokens) as $ctx
		| (if $in > 0 then $cached / $in else 1 end) as $hit
		| select(($in > $cache_min and ($hit * 100) < $low_cache_percent) or $ctx > $context_peak)
		| "\($f)\tin=\($in)\tcached=\($cached)\thit=\($hit * 100 | round)%\tfinal_ctx=\($ctx)"
	' "$f" 2>/dev/null
done
echo
echo "(警告フラグゼロの節は空 = 問題なし)"


echo
echo "## OMP 改善診断"
echo
echo '> 集計期間は上記と同じ '"${CUTOFF}"' 以降（ローカル日付境界を含む）。利用量は `~/.omp/stats.db` の正規化済み記録を使い、raw JSONL を再集計しない。compaction / handoff / prewalk は同DBにないため、`~/.omp/agent/sessions` のイベントIDを重複排除して数える。'
echo

SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
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
	echo 'model	agent_type	calls	sessions	fresh_input	cache_read	cache_write	cache_read_share	output	cost'
	OMP_MODELS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT model, agent_type, COUNT(*), COUNT(DISTINCT session_file),
			       SUM(input_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
			       COALESCE(ROUND(
			           100.0 * SUM(cache_read_tokens)
			           / NULLIF(SUM(input_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens), 0),
			           1
			       ), 0) || '%',
			       SUM(output_tokens), ROUND(SUM(cost_total), 2)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS
			GROUP BY model, agent_type
			ORDER BY SUM(input_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens) DESC;
		" 2>/dev/null
	)"
	if [ -n "$OMP_MODELS" ]; then
		printf '%s\n' "$OMP_MODELS"
	else
		echo "(対象期間に完了記録なし)"
	fi

	echo
	echo "### Cache economics"
	echo
	echo '> raw token と価格表換算を分離する。actual_input_cost / no_cache_input_cost は stats.db の価格表による入力コスト比較であり、subscription quota の算定値ではない。'
	echo
	OMP_CACHE_ECONOMICS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT COALESCE(SUM(input_tokens), 0),
			       COALESCE(SUM(cache_read_tokens), 0),
			       COALESCE(SUM(cache_write_tokens), 0),
			       COALESCE(ROUND(
			           100.0 * SUM(cache_read_tokens)
			           / NULLIF(SUM(input_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens), 0),
			           1
			       ), 0),
			       ROUND(COALESCE(SUM(cost_input + cost_cache_read + cost_cache_write), 0), 2),
			       ROUND(COALESCE(SUM(cost_no_cache_input), 0), 2)
			FROM messages
			WHERE timestamp >= $CUTOFF_MS;
		" 2>/dev/null
	)"
	if [ -n "$OMP_CACHE_ECONOMICS" ]; then
		IFS=$'\t' read -r OMP_FRESH OMP_CACHE_READ OMP_CACHE_WRITE OMP_CACHE_SHARE OMP_ACTUAL_INPUT_COST OMP_NO_CACHE_INPUT_COST <<<"$OMP_CACHE_ECONOMICS"
		echo "- fresh=$OMP_FRESH / cache_read=$OMP_CACHE_READ / cache_write=$OMP_CACHE_WRITE / cache_read_share=${OMP_CACHE_SHARE}%"
		echo "- actual_input_cost=\$$OMP_ACTUAL_INPUT_COST / no_cache_input_cost=\$$OMP_NO_CACHE_INPUT_COST"
	else
		echo "- 取得不能（stats.db の照会に失敗）。"
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
	echo "### Context growth"
	echo
	echo "> 閾値: peak context >= ${CONTEXT_PEAK_TOKENS} tokens または単一応答間の増分 >= ${CONTEXT_JUMP_TOKENS} tokens。session_file はローカル調査用。"
	echo
	echo 'session_file	role	calls	peak_context	max_context_jump	models'
	OMP_CONTEXT_GROWTH="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			WITH ordered AS (
				SELECT session_file, agent_type, timestamp, model,
				       input_tokens + cache_read_tokens + cache_write_tokens AS context_tokens,
				       (input_tokens + cache_read_tokens + cache_write_tokens)
				         - LAG(input_tokens + cache_read_tokens + cache_write_tokens)
				           OVER (PARTITION BY session_file, agent_type ORDER BY timestamp) AS context_delta
				FROM messages
				WHERE timestamp >= $CUTOFF_MS
			)
			SELECT session_file, agent_type, COUNT(*), MAX(context_tokens),
			       MAX(CASE WHEN context_delta > 0 THEN context_delta ELSE 0 END),
			       COUNT(DISTINCT model)
			FROM ordered
			GROUP BY session_file, agent_type
			HAVING MAX(context_tokens) >= $CONTEXT_PEAK_TOKENS
			    OR MAX(CASE WHEN context_delta > 0 THEN context_delta ELSE 0 END) >= $CONTEXT_JUMP_TOKENS
			ORDER BY MAX(context_tokens) DESC
			LIMIT 8;
		" 2>/dev/null
	)"
	if [ -n "$OMP_CONTEXT_GROWTH" ]; then
		printf '%s\n' "$OMP_CONTEXT_GROWTH"
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
	echo "### Large tool results"
	echo
	echo "> 閾値: stats.db の result_size >= ${LARGE_TOOL_RESULT_SIZE}。大きい結果が後続contextへ残ったかは該当 session のターン推移で確認する。"
	echo
	echo 'tool	agent_type	large_results	total_result_size	max_result_size'
	OMP_LARGE_RESULTS="$(
		sqlite3 -noheader -separator $'\t' "$OMP_STATS" "
			SELECT tool_name, agent_type, COUNT(*), SUM(result_size), MAX(result_size)
			FROM tool_calls
			WHERE timestamp >= $CUTOFF_MS
			  AND result_size >= $LARGE_TOOL_RESULT_SIZE
			GROUP BY tool_name, agent_type
			ORDER BY SUM(result_size) DESC
			LIMIT 8;
		" 2>/dev/null
	)"
	if [ -n "$OMP_LARGE_RESULTS" ]; then
		printf '%s\n' "$OMP_LARGE_RESULTS"
	else
		echo "(該当なし)"
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
echo
echo "### Always-loaded instruction footprint"
echo
echo '> canonical な常駐指示だけを測る。runtime で追加される project instructions、tool schema、plugin prompt は含まない。前回 snapshot / journal と比較して増加理由を確認する。'
echo
instruction_footprint() {
	local label="$1"
	local path="$2"
	if [ -f "$path" ]; then
		echo "- ${label}: $(wc -c <"$path" | tr -d ' ') bytes / $(wc -l <"$path" | tr -d ' ') lines"
	else
		echo "- ${label}: 取得不能（canonical file がない）"
	fi
}
instruction_footprint "global instructions" "$REPO_ROOT/agents/global-instructions.md"
instruction_footprint "OMP appended system" "$REPO_ROOT/omp/APPEND_SYSTEM.md"

echo
echo "### Persistent memory footprint"
echo
echo '> point-in-time の file/byte 数。前回 snapshot / journal と比較し、増加だけで削減せず、memory miss・retrieval miss・stale memory の実例と照合する。内容は出力しない。'
echo

memory_tree_stats() {
	local root="$1"
	local mode="${2:-all}"
	local files=0
	local bytes=0
	local file
	local size
	if [ ! -d "$root" ]; then
		printf '0\t0'
		return
	fi
	while IFS= read -r -d '' file; do
		size="$(wc -c <"$file" | tr -d ' ')"
		files="$((files + 1))"
		bytes="$((bytes + size))"
	done < <(
		if [ "$mode" = "claude-memory" ]; then
			find "$root" -type f -path '*/memory/*' -print0 2>/dev/null
		else
			find "$root" -type f -print0 2>/dev/null
		fi
	)
	printf '%s\t%s' "$files" "$bytes"
}

count_named_dirs() {
	local root="$1"
	local name="$2"
	local count=0
	local dir
	if [ -d "$root" ]; then
		while IFS= read -r -d '' dir; do
			: "$dir"
			count="$((count + 1))"
		done < <(find "$root" -type d -name "$name" -print0 2>/dev/null)
	fi
	printf '%s' "$count"
}

OMP_MEMORY_ROOT="$HOME/.omp/agent/memories"
CLAUDE_PROJECTS="$HOME/.claude/projects"
CODEX_MEMORY_ROOT="$HOME/.codex/memories"
CODEX_MEMORY_DB="$HOME/.codex/memories_1.sqlite"

IFS=$'\t' read -r OMP_MEMORY_FILES OMP_MEMORY_BYTES <<<"$(memory_tree_stats "$OMP_MEMORY_ROOT")"
IFS=$'\t' read -r CLAUDE_MEMORY_FILES CLAUDE_MEMORY_BYTES <<<"$(memory_tree_stats "$CLAUDE_PROJECTS" claude-memory)"
CLAUDE_MEMORY_SCOPES="$(count_named_dirs "$CLAUDE_PROJECTS" memory)"
IFS=$'\t' read -r CODEX_MEMORY_FILES CODEX_MEMORY_BYTES <<<"$(memory_tree_stats "$CODEX_MEMORY_ROOT")"

OMP_MEMORY_SCOPES=0
OMP_MEMORY_ROLLOUTS=0
OMP_MEMORY_SKILLS=0
if [ -d "$OMP_MEMORY_ROOT" ]; then
	while IFS= read -r -d '' scope; do
		OMP_MEMORY_SCOPES="$((OMP_MEMORY_SCOPES + 1))"
	done < <(find "$OMP_MEMORY_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
	OMP_MEMORY_ROLLOUTS="$(find "$OMP_MEMORY_ROOT" -type f -path '*/rollout_summaries/*' 2>/dev/null | wc -l | tr -d ' ')"
	OMP_MEMORY_SKILLS="$(find "$OMP_MEMORY_ROOT" -type f -path '*/skills/*' 2>/dev/null | wc -l | tr -d ' ')"
fi

echo 'store	scopes	files	bytes	records'
echo "OMP	$OMP_MEMORY_SCOPES	$OMP_MEMORY_FILES	$OMP_MEMORY_BYTES	rollouts=$OMP_MEMORY_ROLLOUTS skills=$OMP_MEMORY_SKILLS"
echo "Claude Code	$CLAUDE_MEMORY_SCOPES	$CLAUDE_MEMORY_FILES	$CLAUDE_MEMORY_BYTES	project memory files"
echo "Codex files	$([ -d "$CODEX_MEMORY_ROOT" ] && echo 1 || echo 0)	$CODEX_MEMORY_FILES	$CODEX_MEMORY_BYTES	memory files"

if [ -f "$CODEX_MEMORY_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
	CODEX_MEMORY_DB_BYTES="$(wc -c <"$CODEX_MEMORY_DB" | tr -d ' ')"
	CODEX_MEMORY_TABLES="$(sqlite3 "$CODEX_MEMORY_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('jobs','stage1_outputs');" 2>/dev/null)"
	CODEX_MEMORY_JOBS="-"
	CODEX_MEMORY_STAGE1="-"
	if printf '%s\n' "$CODEX_MEMORY_TABLES" | grep -qx jobs; then
		CODEX_MEMORY_JOBS="$(sqlite3 "$CODEX_MEMORY_DB" 'SELECT COUNT(*) FROM jobs;' 2>/dev/null || echo '?')"
	fi
	if printf '%s\n' "$CODEX_MEMORY_TABLES" | grep -qx stage1_outputs; then
		CODEX_MEMORY_STAGE1="$(sqlite3 "$CODEX_MEMORY_DB" 'SELECT COUNT(*) FROM stage1_outputs;' 2>/dev/null || echo '?')"
	fi
	echo "Codex DB	1	1	$CODEX_MEMORY_DB_BYTES	jobs=$CODEX_MEMORY_JOBS stage1_outputs=$CODEX_MEMORY_STAGE1"
else
	echo "Codex DB	0	0	0	取得不能"
fi

if [ -d "$OMP_MEMORY_ROOT" ] && [ "$OMP_MEMORY_SCOPES" -gt 0 ]; then
	echo
	echo 'omp_scope	summary_bytes	index_bytes	raw_bytes	rollouts	skills'
	OMP_MEMORY_SHOWN=0
	while IFS= read -r -d '' scope; do
		if [ "$OMP_MEMORY_SHOWN" -lt 20 ]; then
			scope_name="$(basename "$scope")"
			summary_bytes="$([ -f "$scope/memory_summary.md" ] && wc -c <"$scope/memory_summary.md" | tr -d ' ' || echo 0)"
			index_bytes="$([ -f "$scope/MEMORY.md" ] && wc -c <"$scope/MEMORY.md" | tr -d ' ' || echo 0)"
			raw_bytes="$([ -f "$scope/raw_memories.md" ] && wc -c <"$scope/raw_memories.md" | tr -d ' ' || echo 0)"
			rollouts="$(find "$scope/rollout_summaries" -type f 2>/dev/null | wc -l | tr -d ' ')"
			skills="$(find "$scope/skills" -type f 2>/dev/null | wc -l | tr -d ' ')"
			echo "$scope_name	$summary_bytes	$index_bytes	$raw_bytes	$rollouts	$skills"
			OMP_MEMORY_SHOWN="$((OMP_MEMORY_SHOWN + 1))"
		fi
	done < <(find "$OMP_MEMORY_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)
	if [ "$OMP_MEMORY_SCOPES" -gt "$OMP_MEMORY_SHOWN" ]; then
		echo "($((OMP_MEMORY_SCOPES - OMP_MEMORY_SHOWN)) scopes hidden; aggregate above includes all)"
	fi
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
echo "- instruction footprint は canonical file の byte/line 数であり、実リクエストの token count ではない。増加だけで削減を提案せず、cache write と再利用頻度を照合する。"
echo "- persistent memory footprint は snapshot 時点の容量であり、期間内の増分や参照回数ではない。参照履歴がない store は利用 0 と判定しない。"
echo "- この snapshot は計測と drift 検出だけを行い、設定・plugin・セッションを変更しない。"
