#!/bin/bash
# herdr-collab: メッセージファイルを書き、宛先の settle を待って herdr prompt で配送する。
#
# usage:
#   send.sh --to <target[,second-target]> --tag <handoff|review-req|findings|cross-check|consolidated|applied|verified|decision|fyi> \
#           [--flow <name>] [--from <name>] [--body <file>|-] \
#           [--record-only] [--file <既存ファイル>] [--retry-target <failed-target>] \
#           [--wait-timeout <ms>] [--root <dir>]
#
# 本文: --body FILE / --body - (stdin) / 引数なしで stdin。
# --record-only は新規ファイルを採番・検証して、Herdr prompt を配送せず返る。
# --file は作成済みファイルの再配送用。group の部分失敗は header 全体を --to に保ち、
# --retry-target で失敗した一宛先だけを再配送する。
# 置き場所: <root>/.agent-msgs/<flow>/NN-<tag>.md (root default: git toplevel、なければ $PWD)。
# exit: 0=記録済み、または配送済み (配送時は宛先の working 遷移=着火まで確認。
#       未観測なら警告を添えて 0)
#       2=引数エラー 3=ファイルは在るが未配送 (blocked / timeout / stalled 未着火)
set -euo pipefail

die() { echo "send.sh: $*" >&2; exit 2; }

require_message_body() {
  local path="$1" line line_number=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    [ "$line_number" -le 4 ] && continue
    case "$line" in
      *[![:space:]]*) return 0 ;;
    esac
  done <"$path"
  die "message body is empty or whitespace-only: $path"
}

release_ledger_lock() {
  if [ -n "$LOCK_DIR" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_DIR=""
  fi
}

cleanup_locked_message() {
  if [ -n "$LOCK_DIR" ]; then
    [ "$CREATED" = 1 ] && [ -n "$FILE" ] && rm -f "$FILE"
    release_ledger_lock
  fi
}

TO="" TAG="" FLOW="collab" FROM="" BODY="" FILE="" RETRY_TARGET="" WAIT_TIMEOUT=300000 ROOT="" CREATED=0 LOCK_DIR="" RECORD_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --flow) FLOW="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --record-only) RECORD_ONLY=1; shift ;;
    --file) FILE="$2"; shift 2 ;;
    --retry-target) RETRY_TARGET="$2"; shift 2 ;;
    --wait-timeout) WAIT_TIMEOUT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[ "${HERDR_ENV:-}" = 1 ] || die "not inside a herdr pane (HERDR_ENV != 1)"
[ -n "$TO" ] || die "--to is required"
if [ "$RECORD_ONLY" = 1 ]; then
  [ -z "$FILE" ] || die "--record-only creates a new ledger file and cannot be combined with --file"
  [ -z "$RETRY_TARGET" ] || die "--record-only cannot be combined with --retry-target"
  [ -n "$FROM" ] || die "--record-only requires explicit --from so it never calls Herdr"
fi

case "$TO" in
  ,*|*,|*,,*) die "--to targets must be nonempty and comma-separated" ;;
esac
IFS=',' read -r -a TARGETS <<<"$TO"
[ "${#TARGETS[@]}" -le 2 ] || die "--to supports one target or a two-reviewer panel"
for target in "${TARGETS[@]}"; do
  case "$target" in
    *[[:space:]]*) die "--to targets must not contain whitespace" ;;
  esac
done
if [ "${#TARGETS[@]}" -eq 2 ] && [ "${TARGETS[0]}" = "${TARGETS[1]}" ]; then
  die "--to targets must be distinct"
fi
ROOT="${ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "--file not found: $FILE"
  file_from_line=""
  file_to_line=""
  {
    IFS= read -r file_from_line || true
    IFS= read -r file_to_line || true
  } <"$FILE"
  case "$file_from_line" in
    "from: "*) FILE_FROM="${file_from_line#from: }" ;;
    *) die "--file has no valid from header: $FILE" ;;
  esac
  case "$file_to_line" in
    "to: "*) FILE_TO="${file_to_line#to: }" ;;
    *) die "--file has no valid to header: $FILE" ;;
  esac
  [ "$TO" = "$FILE_TO" ] || die "--to must exactly match the file to header ($FILE_TO)"
  [ -z "$FROM" ] || [ "$FROM" = "$FILE_FROM" ] || die "--from must exactly match the file from header ($FILE_FROM)"
  FROM="$FILE_FROM"
  TAG="$(basename "$FILE" .md)"; TAG="${TAG#*-}"
  if [ -n "$RETRY_TARGET" ]; then
    case "$RETRY_TARGET" in
      *","*|*[[:space:]]*) die "--retry-target must be one target without commas or whitespace" ;;
    esac
    retry_member=0
    for target in "${TARGETS[@]}"; do
      [ "$target" != "$RETRY_TARGET" ] || retry_member=1
    done
    [ "$retry_member" = 1 ] || die "--retry-target must belong to the file to header"
    TARGETS=("$RETRY_TARGET")
  fi
else
  [ -z "$RETRY_TARGET" ] || die "--retry-target requires --file"
  if [ -z "$FROM" ]; then
    FROM="$(herdr agent get "$HERDR_PANE_ID" 2>/dev/null | jq -r '.result.agent.name // empty')"
    FROM="${FROM:-$HERDR_PANE_ID}"
  fi
  case "$TAG" in
    handoff|review-req|findings|cross-check|consolidated|applied|verified|decision|fyi) ;;
    *) die "--tag must be one of handoff|review-req|findings|cross-check|consolidated|applied|verified|decision|fyi" ;;
  esac
  [ -n "$BODY" ] || [ ! -t 0 ] || die "本文がない: --body FILE / --body - / stdin のいずれかで渡す"

  DIR="$ROOT/.agent-msgs/$FLOW"
  mkdir -p "$DIR"
  LOCK_DIR="$DIR/.send-lock"
  lock_attempts=0
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    lock_attempts=$((lock_attempts + 1))
    if [ "$lock_attempts" -ge 300 ]; then
      echo "send.sh: ledger lock timeout: $LOCK_DIR" >&2
      exit 3
    fi
    sleep 0.1
  done
  trap cleanup_locked_message EXIT
  trap 'exit 3' HUP INT TERM
  n=0
  for f in "$DIR"/[0-9]*-*.md; do
    [ -e "$f" ] || continue
    num="${f##*/}"; num="${num%%-*}"; num=$((10#$num))
    [ "$num" -gt "$n" ] && n=$num
  done
  FILE="$DIR/$(printf '%02d' $((n + 1)))-$TAG.md"
  CREATED=1

  {
    printf 'from: %s\nto: %s\ndate: %s\n\n' "$FROM" "$TO" "$(date '+%Y-%m-%d %H:%M:%S')"
    if [ -n "$BODY" ] && [ "$BODY" != - ]; then cat "$BODY"; else cat; fi
  } >"$FILE"
  :
fi

case "$TAG" in
  handoff|review-req|findings|cross-check|consolidated|applied|verified|decision|fyi) ;;
  *) die "--tag must be one of handoff|review-req|findings|cross-check|consolidated|applied|verified|decision|fyi" ;;
esac

require_message_body "$FILE"

case "$TAG" in
  review-req|findings|cross-check|consolidated|applied|verified|decision|fyi) REVIEW_TAG=1 ;;
  *) REVIEW_TAG=0 ;;
esac
if [ "$REVIEW_TAG" = 1 ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! validation_out="$("$SCRIPT_DIR/review-flow.py" validate-message "$FILE" 2>&1)"; then
    [ "$CREATED" = 1 ] && rm -f "$FILE"
    echo "send.sh: review flow validation failed." >&2
    printf '%s\n' "$validation_out" >&2
    exit 2
  fi
fi

release_ledger_lock
trap - EXIT HUP INT TERM

ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
TAGU="$(printf '%s' "$TAG" | tr '[:lower:]' '[:upper:]')"
if [ "$RECORD_ONLY" = 1 ]; then
  echo "recorded=$ABS to=$TO"
  exit 0
fi

deliver_target() {
  local target="$1" wait_out status prompt_out st ignited

  # working 中に注入しない: settle (idle/done/blocked) を待つ。
  if ! wait_out="$(herdr agent wait "$target" --timeout "$WAIT_TIMEOUT" 2>&1)"; then
    echo "send.sh: $target の settle 待ちに失敗。ファイルは $ABS に在る。ペインの生死を確認し、--file で再配送する。" >&2
    printf '%s\n' "$wait_out" >&2
    return 3
  fi
  status="$(printf '%s' "$wait_out" | jq -r '[.. | .agent_status? // empty] | first // empty' 2>/dev/null || true)"
  if [ "$status" = blocked ]; then
    echo "send.sh: $target は blocked (承認/入力待ち)。注入しない。\`herdr agent read $target\` で内容を確認し、解消後に --file $ABS で再配送する。" >&2
    return 3
  fi

  PROMPT_TEXT="[$TAGU from $FROM] $ABS を読んで対応して"
  if ! prompt_out="$(herdr agent prompt "$target" "$PROMPT_TEXT" 2>&1)"; then
    case "$prompt_out" in
      *agent_prompt_stalled*)
        # 0.8.0 では稀 (herdr#1878 修正済み) だが、入力欄にテキストが残った場合の保険。
        herdr agent send-keys "$target" enter >/dev/null 2>&1 || true
        sleep 2
        st="$(herdr agent get "$target" 2>/dev/null | jq -r '.result.agent.agent_status // empty')"
        if [ "$st" = working ]; then
          echo "sent=$ABS to=$target (stalled -> enter で着火)"
          return 0
        fi
        echo "send.sh: prompt が stalled のまま着火せず。\`herdr agent read $target\` で状態を確認し、--file $ABS で再配送する。" >&2
        return 3
        ;;
      *)
        echo "send.sh: prompt 失敗。ファイルは $ABS に在る。" >&2
        printf '%s\n' "$prompt_out" >&2
        return 3
        ;;
    esac
  fi

  # 着火確認: prompt 受理後、宛先の working 遷移を短時間ポーリングする。
  # これをしないと、呼び出し側が直後に `herdr agent wait` したとき配送前の
  # settle を拾い、まだ書かれていない返信を「完了済み」と誤判定するレースになる。
  ignited=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    st="$(herdr agent get "$target" 2>/dev/null | jq -r '.result.agent.agent_status // empty')"
    if [ "$st" = working ]; then
      ignited=1
      break
    fi
    sleep 1
  done
  if [ "$ignited" = 1 ]; then
    echo "sent=$ABS to=$target"
  else
    echo "sent=$ABS to=$target (working 遷移を 10 秒間観測できず。超高速タスクなら settle 済みの可能性もある — \`herdr agent read $target\` で確認)"
  fi
}

delivery_failed=0
for target in "${TARGETS[@]}"; do
  if ! deliver_target "$target"; then
    delivery_failed=1
  fi
done
[ "$delivery_failed" = 0 ] || exit 3
