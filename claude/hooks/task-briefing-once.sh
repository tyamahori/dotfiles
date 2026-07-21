#!/bin/bash
# UserPromptSubmit hook: task-briefing チェックリストをセッション初回の1回だけ注入する。
# 毎ターン全文を注入するとwatcher通知等の機械的なターンにも約1.5k tokensが乗るため、
# session_id ごとの状態ファイルでデデュープする（2026-07-21 セッション節約振り返りより）。
input=$(cat)
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$sid" ] || sid="unknown"
state_dir="${TMPDIR:-/tmp}/claude-task-briefing"
mkdir -p "$state_dir" 2>/dev/null
state="$state_dir/$sid"
[ -f "$state" ] && exit 0
: > "$state"
cat "$HOME/dotfiles/agents/task-briefing.md" 2>/dev/null || true
