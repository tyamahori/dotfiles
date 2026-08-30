#!/bin/bash
# omp-herdr-collab: フローのメッセージ一覧を番号順にヘッダ付きで表示する。
# usage: inbox.sh [--flow <name>] [--root <dir>]
set -euo pipefail

FLOW=collab ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --flow) FLOW="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    *) echo "inbox.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done
ROOT="${ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
DIR="$ROOT/.agent-msgs/$FLOW"
[ -d "$DIR" ] || { echo "no messages: $DIR"; exit 0; }

found=0
for f in "$DIR"/[0-9]*-*.md; do
  [ -e "$f" ] || continue
  found=1
  printf '%s | %s\n' "$(basename "$f")" "$(sed -n '1,3p' "$f" | tr '\n' ' ')"
done
[ "$found" = 1 ] || echo "no messages: $DIR"
