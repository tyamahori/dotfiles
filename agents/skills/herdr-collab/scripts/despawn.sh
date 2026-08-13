#!/bin/bash
# herdr-collab: spawn.sh で開けたピアのペインを閉じる。
# agmsg の placement 記録が存在しないので pane close だけで完結する。
# 自分 (このフロー) が開けたペイン以外には使わない。
# usage: despawn.sh <target(agent名|pane_id)>
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || { echo "despawn.sh: not inside a herdr pane (HERDR_ENV != 1)" >&2; exit 1; }
T="${1:?usage: despawn.sh <target>}"

PANE="$(herdr agent get "$T" 2>/dev/null | jq -r '.result.agent.pane_id // empty')"
[ -n "$PANE" ] || { echo "despawn.sh: no live agent/pane for: $T" >&2; exit 1; }

herdr pane close "$PANE" >/dev/null
echo "closed=$PANE"
