#!/bin/bash
# PR の状態か未解決スレッドが変わるまで待って終了する。待機中は LLM を使わない。
# エージェントは sleep+gh を毎ターン繰り返す代わりに、これをバックグラウンドで 1 本張る
# (変化なしでもターンを消費する起床が出ないように)。
# usage: await-pr-change.sh <owner> <repo> <number> [interval_sec=300]
set -euo pipefail
owner=$1 repo=$2 number=$3 interval=${4:-300}

fingerprint() {
  # shellcheck disable=SC2016 # $owner などは GraphQL 変数で、シェル展開させない
  gh api graphql -F owner="$owner" -F name="$repo" -F number="$number" -f query='
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      reviewThreads(first: 100) { nodes { id isResolved comments { totalCount } } }
    }
  }
}' --jq '.data.repository.pullRequest
    | [.state] + [.reviewThreads.nodes[] | select(.isResolved | not) | "\(.id):\(.comments.totalCount)"]
    | join(" ")'
}

initial=$(fingerprint)
# merged / closed なら変化を待つ意味がない
case $initial in OPEN*) ;; *) echo "PR #$number is ${initial%% *}"; exit 0 ;; esac
while :; do
  sleep "$interval"
  # 一時的な API 失敗では抜けない(抜けると空振りの起床になる)
  current=$(fingerprint) || continue
  if [ "$current" != "$initial" ]; then
    echo "PR #$number changed: $current"
    exit 0
  fi
done
