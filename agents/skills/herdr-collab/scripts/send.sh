#!/bin/bash
# herdr-collab: メッセージファイルを書き、宛先の settle を待って herdr prompt で配送する。
#
# usage:
#   send.sh --to <target> --tag <handoff|review-req|findings|applied|fyi> \
#           [--flow <name>] [--from <name>] [--body <file>|-] \
#           [--file <既存ファイル>] [--wait-timeout <ms>] [--root <dir>]
#
# 本文: --body FILE / --body - (stdin) / 引数なしで stdin。
# --file は作成済みファイルの再配送 (blocked 後のリトライ) 用。新規ファイルを作らない。
# 置き場所: <root>/.agent-msgs/<flow>/NN-<tag>.md (root default: git toplevel、なければ $PWD)。
# exit: 0=配送済み (宛先の working 遷移=着火まで確認。未観測なら警告を添えて 0)
#       2=引数エラー 3=ファイルは在るが未配送 (blocked / timeout / stalled 未着火)
set -euo pipefail

die() { echo "send.sh: $*" >&2; exit 2; }

TO="" TAG="" FLOW="collab" FROM="" BODY="" FILE="" WAIT_TIMEOUT=300000 ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --wait-timeout) WAIT_TIMEOUT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[ "${HERDR_ENV:-}" = 1 ] || die "not inside a herdr pane (HERDR_ENV != 1)"
[ -n "$TO" ] || die "--to is required"
ROOT="${ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

if [ -z "$FROM" ]; then
  FROM="$(herdr agent get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.agent.name // empty')"
  FROM="${FROM:-$HERDR_PANE_ID}"
fi

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "--file not found: $FILE"
  TAG="$(basename "$FILE" .md)"; TAG="${TAG#*-}"
else
  case "$TAG" in
    handoff|review-req|findings|applied|fyi) ;;
    *) die "--tag must be one of handoff|review-req|findings|applied|fyi" ;;
  esac
  [ -n "$BODY" ] || [ ! -t 0 ] || die "本文がない: --body FILE / --body - / stdin のいずれかで渡す"

  DIR="$ROOT/.agent-msgs/$FLOW"
  mkdir -p "$DIR"
  n=0
  for f in "$DIR"/[0-9]*-*.md; do
    [ -e "$f" ] || continue
    num="${f##*/}"; num="${num%%-*}"; num=$((10#$num))
    [ "$num" -gt "$n" ] && n=$num
  done
  FILE="$DIR/$(printf '%02d' $((n + 1)))-$TAG.md"

  {
    printf 'from: %s\nto: %s\ndate: %s\n\n' "$FROM" "$TO" "$(date '+%Y-%m-%d %H:%M:%S')"
    if [ -n "$BODY" ] && [ "$BODY" != - ]; then cat "$BODY"; else cat; fi
  } >"$FILE"
fi

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
TAGU="$(printf '%s' "$TAG" | tr '[:lower:]' '[:upper:]')"

# working 中に注入しない: settle (idle/done/blocked) を待つ。
if ! wait_out="$(herdr agent wait "$TO" --timeout "$WAIT_TIMEOUT" 2>&1)"; then
  echo "send.sh: $TO の settle 待ちに失敗。ファイルは $ABS に在る。ペインの生死を確認し、--file で再配送する。" >&2
  printf '%s\n' "$wait_out" >&2
  exit 3
fi
status="$(printf '%s' "$wait_out" | jq -r '[.. | .agent_status? // empty] | first // empty' 2>/dev/null || true)"
if [ "$status" = blocked ]; then
  echo "send.sh: $TO は blocked (承認/入力待ち)。注入しない。\`herdr agent read $TO\` で内容を確認し、解消後に --file $ABS で再配送する。" >&2
  exit 3
fi

PROMPT_TEXT="[$TAGU from $FROM] $ABS を読んで対応して"
if ! prompt_out="$(herdr agent prompt "$TO" "$PROMPT_TEXT" 2>&1)"; then
  case "$prompt_out" in
    *agent_prompt_stalled*)
      # 0.8.0 では稀 (herdr#1878 修正済み) だが、入力欄にテキストが残った場合の保険。
      herdr agent send-keys "$TO" enter >/dev/null 2>&1 || true
      sleep 2
      st="$(herdr agent get "$TO" 2>/dev/null | jq -r '.result.agent.agent_status // empty')"
      if [ "$st" = working ]; then
        echo "sent=$ABS to=$TO (stalled -> enter で着火)"
        exit 0
      fi
      echo "send.sh: prompt が stalled のまま着火せず。\`herdr agent read $TO\` で状態を確認し、--file $ABS で再配送する。" >&2
      exit 3
      ;;
    *)
      echo "send.sh: prompt 失敗。ファイルは $ABS に在る。" >&2
      printf '%s\n' "$prompt_out" >&2
      exit 3
      ;;
  esac
fi

# 着火確認: prompt 受理後、宛先の working 遷移を短時間ポーリングする。
# これをしないと、呼び出し側が直後に `herdr agent wait` したとき配送前の
# settle を拾い、まだ書かれていない返信を「完了済み」と誤判定するレースになる。
ignited=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  st="$(herdr agent get "$TO" 2>/dev/null | jq -r '.result.agent.agent_status // empty')"
  [ "$st" = working ] && { ignited=1; break; }
  sleep 1
done
if [ "$ignited" = 1 ]; then
  echo "sent=$ABS to=$TO"
else
  echo "sent=$ABS to=$TO (working 遷移を 10 秒間観測できず。超高速タスクなら settle 済みの可能性もある — \`herdr agent read $TO\` で確認)"
fi
