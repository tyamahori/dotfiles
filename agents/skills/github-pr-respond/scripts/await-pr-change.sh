#!/bin/bash
# PR の状態・CI の結論・レビュー・会話コメント・未解決スレッドのどれかが変わるまで
# 待って終了する。待機中は LLM を使わない。
# エージェントは sleep+gh を毎ターン繰り返す代わりに、これをバックグラウンドで 1 本張る
# (変化なしでもターンを消費する起床が出ないように)。
# usage: await-pr-change.sh <owner> <repo> <number> [interval_sec=300]
set -euo pipefail
owner=$1 repo=$2 number=$3 interval=${4:-300}

fingerprint() {
  # CI は SUCCESS / FAILURE / ERROR の結論だけを見る。PENDING・EXPECTED・未登録(null)は
  # 同じ "-" に畳む: push 直後に null→PENDING へ移るだけで起きると空振りになるため。
  # shellcheck disable=SC2016 # $owner などは GraphQL 変数で、シェル展開させない
  gh api graphql -F owner="$owner" -F name="$repo" -F number="$number" -f query='
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviews { totalCount }
      comments { totalCount }
      reviewThreads(first: 100) { nodes { id isResolved comments { totalCount } } }
    }
  }
}' --jq '.data.repository.pullRequest
    | (.commits.nodes[0].commit.statusCheckRollup.state // "") as $ci
    | ["state=\(.state)",
       "ci=\(if $ci == "SUCCESS" or $ci == "FAILURE" or $ci == "ERROR" then $ci else "-" end)",
       "reviews=\(.reviews.totalCount)",
       "comments=\(.comments.totalCount)"]
      + [.reviewThreads.nodes[] | select(.isResolved | not) | "\(.id):\(.comments.totalCount)"]
    | join(" ")'
}

initial=$(fingerprint)
# merged / closed なら変化を待つ意味がない
case $initial in state=OPEN*) ;; *) echo "PR #$number is ${initial%% *}"; exit 0 ;; esac
while :; do
  sleep "$interval"
  # 一時的な API 失敗では抜けない(抜けると空振りの起床になる)
  current=$(fingerprint) || continue
  if [ "$current" != "$initial" ]; then
    echo "PR #$number changed: $current"
    exit 0
  fi
done
