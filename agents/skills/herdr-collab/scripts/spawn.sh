#!/bin/bash
# herdr-collab: herdr ペインへピア CLI を起動する。
#
# usage: spawn.sh <kind> [name]
#   kind: herdr の agent kind (claude|codex|omp|copilot|...)。一覧は `herdr agent`。
#   name: herdr agent 名 (default: <ディレクトリ名>-<kind>)。[a-z][a-z0-9_-]{0,31}。
# env: HC_PARENT_PANE      分割元ペイン (default: $HERDR_PANE_ID)
#      HC_SPLIT_DIRECTION  right|down (default: down)
#      HC_SPLIT_RATIO      新ペインの比率 (default: 0.35)
#      HC_CWD              新ペインの cwd (default: $PWD)
#      HC_START_TIMEOUT_MS agent start のタイムアウト (default: 60000)
# stdout: name=<agent名> pane=<pane_id>
#
# `herdr agent start` はエージェント検出・入力受付可能まで待ってから返る。
# 起動に失敗したら開けたペインを閉じて exit 1。
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || { echo "spawn.sh: not inside a herdr pane (HERDR_ENV != 1)" >&2; exit 1; }
KIND="${1:?usage: spawn.sh <kind> [name]}"

BASE="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
DEFAULT_NAME="$(printf '%s-%s' "$BASE" "$KIND" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^[^a-z]+//' | cut -c1-32)"
NAME="${2:-$DEFAULT_NAME}"

out="$(herdr pane split "${HC_PARENT_PANE:-$HERDR_PANE_ID}" \
  --direction "${HC_SPLIT_DIRECTION:-down}" \
  --ratio "${HC_SPLIT_RATIO:-0.35}" \
  --cwd "${HC_CWD:-$PWD}" \
  --no-focus)"
PANE="$(printf '%s' "$out" | jq -r '.result.pane.pane_id // empty')"
[ -n "$PANE" ] || { echo "spawn.sh: no pane_id in: $out" >&2; exit 1; }

# 分割直後はシェルがまだ立っておらず agent_pane_busy で弾かれることがある。
# シェルが available になるまで最大 10 秒リトライする。
started=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if err="$(herdr agent start "$NAME" --kind "$KIND" --pane "$PANE" \
      --timeout "${HC_START_TIMEOUT_MS:-60000}" 2>&1 >/dev/null)"; then
    started=1
    break
  fi
  case "$err" in
    *agent_pane_busy*|*"not an available shell"*) sleep 1 ;;
    *) break ;;
  esac
done
if [ "$started" != 1 ]; then
  echo "spawn.sh: agent start failed for kind=$KIND; closing pane $PANE" >&2
  printf '%s\n' "${err:-}" >&2
  herdr pane close "$PANE" >/dev/null 2>&1 || true
  exit 1
fi

echo "name=$NAME pane=$PANE"
