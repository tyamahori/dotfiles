#!/bin/bash
# omp-herdr-collab: spawn.sh で開けたピアを片付ける。
# worktree workspace にひとりで居る worker なら worktree ごと外し、それ以外はペインだけ閉じる
# (workers workspace は最後のペインが閉じると herdr が一緒に閉じる)。
# 自分 (このフロー) が開けたペイン以外には使わない。
# usage: despawn.sh <target(agent名|spawn.sh が返した pane_id)>
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || { echo "despawn.sh: not inside a herdr pane (HERDR_ENV != 1)" >&2; exit 1; }
T="${1:?usage: despawn.sh <target>}"

if [[ "$T" =~ ^w[0-9A-Za-z]+:p[0-9A-Za-z]+$ ]]; then
  PANE="$T"
else
  # pipefail: agent get exits 1 for an unknown/exited agent; fall through to the message below.
  PANE="$(herdr agent get "$T" 2>/dev/null | jq -r '.result.agent.pane_id // empty')" || true
fi
[ -n "$PANE" ] || {
  echo "despawn.sh: no live agent for: $T; if it already exited, pass the pane_id returned by spawn.sh" >&2
  exit 1
}

WS="$(herdr pane get "$PANE" 2>/dev/null | jq -r '.result.pane.workspace_id // empty')" || WS=""
if [ -n "$WS" ] \
  && herdr workspace get "$WS" | jq -e '.result.workspace.worktree.is_linked_worktree == true' >/dev/null \
  && [ "$(herdr pane list --workspace "$WS" | jq '.result.panes | length')" = 1 ]; then
  # --force は付けない。未コミットの変更は worker の成果なので、消すかどうかはユーザーが決める。
  herdr worktree remove --workspace "$WS" >/dev/null || {
    echo "despawn.sh: herdr refused to remove worktree workspace $WS (uncommitted changes?); nothing closed" >&2
    exit 1
  }
  echo "removed=$WS"
  exit 0
fi

herdr pane close "$PANE" >/dev/null
echo "closed=$PANE"
