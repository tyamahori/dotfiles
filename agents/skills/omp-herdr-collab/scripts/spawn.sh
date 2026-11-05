#!/bin/bash
# omp-herdr-collab: ピア CLI を coordinator とは別の herdr workspace に起動する。
#
# usage: spawn.sh <kind> [name]
#   kind: herdr の agent kind (claude|codex|omp|copilot|...)。一覧は `herdr agent`。
#   name: herdr agent 名 (default: <ディレクトリ名>-<kind>)。[a-z][a-z0-9_-]{0,31}。
# 置き場所:
#   既定        <ディレクトリ名>-workers workspace (無ければ作る) のペイン。reviewer 向け
#   HC_WORKTREE_BRANCH=<branch>
#               そのブランチの herdr worktree workspace (label=<name>)。実装 worker 向け。
#               ブランチが既にあれば worktree open、無ければ worktree create
# env: HC_WORKTREE_BASE    worktree create の --base (default: herdr の既定)
#      HC_CWD              repo / 新ペインの cwd (default: $PWD)
#      HC_START_TIMEOUT_MS agent start のタイムアウト (default: 60000)
# stdout: name=<agent名> pane=<pane_id> workspace=<workspace_id> cwd=<ピアの cwd>
#
# `herdr agent start` はエージェント検出・入力受付可能まで待ってから返る。
# 起動に失敗したら、この呼び出しで作ったもの (ペイン / workspace / worktree) だけを
# 片付けて exit 1。既存の workers workspace やそのペインには触れない。
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || { echo "spawn.sh: not inside a herdr pane (HERDR_ENV != 1)" >&2; exit 1; }
KIND="${1:?usage: spawn.sh <kind> [name]}"
CWD="${HC_CWD:-$PWD}"

BASE="$(basename "$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$CWD")")"
# 32 文字に収めるのはディレクトリ名側だけ。全体を切ると長いディレクトリでは
# kind が削れ、claude と codex が同じ名前になって 2 体目の起動が失敗する。
DEFAULT_NAME="$(printf '%s-%s' "$(printf '%s' "$BASE" | cut -c1-$((31 - ${#KIND})))" "$KIND" \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^[^a-z]+//')"
NAME="${2:-$DEFAULT_NAME}"

die() { echo "spawn.sh: $*" >&2; exit 1; }
field() { jq -r "$1 // empty" <<<"$2"; }

AGENT_ARGS=()
if [ -n "${HC_WORKTREE_BRANCH:-}" ]; then
  if git -C "$CWD" show-ref --verify --quiet "refs/heads/$HC_WORKTREE_BRANCH"; then
    out="$(herdr worktree open --cwd "$CWD" --branch "$HC_WORKTREE_BRANCH" --label "$NAME" --no-focus)"
  else
    out="$(herdr worktree create --cwd "$CWD" --branch "$HC_WORKTREE_BRANCH" \
      ${HC_WORKTREE_BASE:+--base "$HC_WORKTREE_BASE"} --label "$NAME" --no-focus)"
  fi
  # linked worktree の index・objects・refs は本体の .git 配下にあり、Codex の
  # workspace-write sandbox の外になる。足さないと git commit が index.lock で失敗する。
  if [ "$KIND" = codex ]; then
    AGENT_ARGS=(-- --add-dir "$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir)")
  fi
  WS="$(field .result.workspace.workspace_id "$out")"
  PANE="$(field .result.root_pane.pane_id "$out")"
  CWD="$(field '.result.worktree.checkout_path // .result.workspace.worktree.checkout_path' "$out")"
  undo=(herdr worktree remove --workspace "$WS")
else
  LABEL="$BASE-workers"
  # ponytail: label 一致で探すだけ。同時 spawn で同名 workspace が2つできても先頭を使い続けるので実害はない。
  WS="$(herdr workspace list | jq -r --arg l "$LABEL" \
    '[.result.workspaces[] | select(.label == $l)][0].workspace_id // empty')"
  if [ -z "$WS" ]; then
    out="$(herdr workspace create --cwd "$CWD" --label "$LABEL" --no-focus)"
    WS="$(field .result.workspace.workspace_id "$out")"
    PANE="$(field .result.root_pane.pane_id "$out")"
    undo=(herdr workspace close "$WS")
  else
    # ponytail: 常に最後のペインを右へ割る。ピアが4体を超えて列が細くなったら layout を見て向きを選ぶ。
    anchor="$(herdr pane list --workspace "$WS" | jq -r '.result.panes[-1].pane_id // empty')"
    [ -n "$anchor" ] || die "no pane in workspace $WS"
    out="$(herdr pane split "$anchor" --direction right --cwd "$CWD" --no-focus)"
    PANE="$(field .result.pane.pane_id "$out")"
    undo=(herdr pane close "$PANE")
  fi
fi
[ -n "$WS" ] && [ -n "$PANE" ] && [ -n "$CWD" ] || die "unexpected herdr response: $out"

# 作成直後はシェルがまだ立っておらず agent_pane_busy で弾かれることがある。
# シェルが available になるまで最大 10 秒リトライする。
started=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if err="$(herdr agent start "$NAME" --kind "$KIND" --pane "$PANE" \
      --timeout "${HC_START_TIMEOUT_MS:-60000}" ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"} 2>&1 >/dev/null)"; then
    started=1
    break
  fi
  case "$err" in
    *agent_pane_busy*|*"not an available shell"*) sleep 1 ;;
    *) break ;;
  esac
done
if [ "$started" != 1 ]; then
  echo "spawn.sh: agent start failed for kind=$KIND; undoing: ${undo[*]}" >&2
  printf '%s\n' "${err:-}" >&2
  "${undo[@]}" >/dev/null 2>&1 || true
  exit 1
fi

echo "name=$NAME pane=$PANE workspace=$WS cwd=$CWD"
