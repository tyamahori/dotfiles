#!/bin/bash
# omp-herdr-collab: spawn.sh で開けたピアのペインを閉じる。pane close だけで完結する。
# 自分 (このフロー) が開けたペイン以外には使わない。
# usage: despawn.sh <target(agent名|spawn.sh が返した pane_id)>
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || { echo "despawn.sh: not inside a herdr pane (HERDR_ENV != 1)" >&2; exit 1; }
T="${1:?usage: despawn.sh <target>}"

if [[ "$T" =~ ^w[0-9]+:p[0-9]+$ ]]; then
  PANE="$T"
else
  PANE="$(herdr agent get "$T" 2>/dev/null | jq -r '.result.agent.pane_id // empty')"
fi
[ -n "$PANE" ] || {
  echo "despawn.sh: no live agent for: $T; if it already exited, pass the pane_id returned by spawn.sh" >&2
  exit 1
}

herdr pane close "$PANE" >/dev/null
echo "closed=$PANE"
