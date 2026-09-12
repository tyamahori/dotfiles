# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

## タグとテンプレ（正本）

- single のタグは7種: `[REVIEW-REQ]` `[FINDINGS]` `[APPLIED]` `[VERIFIED]`
  `[DECISION]` `[HANDOFF]` `[FYI]`。本文の先頭に置く。panel 専用の
  `[CROSS-CHECK]` `[CONSOLIDATED]` は `omp-herdr-collab-panel` が正本。
- `revision`、`reviewed-revision`、`base-revision`、`result-revision` は
  `commit:` 表記。本文は短文 + 参照にし、diff や長文は貼らない。
- source ID は `finding-N` / `evidence-N` / `confidence-N` の数値 suffix `N`
  そのもの。APPLIED / VERIFIED / DECISION の ID リストは `1,2` と書く。
- FINDINGS / VERIFIED の `reviewed-revision`・`scope`・`result-revision` は
  REVIEW-REQ / APPLIED と完全一致が必要（validator が拒否する）。手書きせず
  `review-flow.py scaffold` の skeleton を使う。

```
[REVIEW-REQ] <一言で対象>
revision: <commit:...>
scope: <対象パスまたは範囲>
focus: <catalog 値または重点。なければ全般>
context: <課題・ゴール1行、または briefing/旧flow への参照>
briefing: <briefing ファイルの絶対パス>
instructions: <templates/reviewer-instructions.md の絶対パス>
coordinator: <安定したペイン名>
ledger-directory: <msgs ディレクトリの絶対パス>
return-mode: <record-only | artifact-import>
return-directory: <artifact-import の場合だけ、絶対パス>
implementer: <identity>
implementer-model: <model family>
reviewer: <identity>
reviewer-model: <model family>
reviewer-context: fresh
```

`briefing` 以下 `return-directory` までは handoff フィールド（任意）。spawn
したてのピアへはこの統合形を最初から送り、`[HANDOFF]` の往復を省略する。
既存ピアへは従来どおり `[HANDOFF]` → go の `[FYI]` → handoff フィールドなしの
`[REVIEW-REQ]` とする。同系統または non-fresh の場合だけ `reviewer-context` を
実態に置き換え、`independence-exception: user-approved: <reason>` を追加する。

```
[FINDINGS] <対象>
reviewed-revision: <REVIEW-REQ revision>
scope: <REVIEW-REQ から逐語>
verification: <読んだ対象・実行した確認>
count: <N>
finding-1: <high|mid|low> <path>:<line> <要約>
evidence-1: <根拠>
confidence-1: <high|mid|low>
```

指摘なしは `count: 0` とし、finding 行を書かない。

```
[APPLIED] <FINDINGS への対応>
base-revision: <reviewed-revision>
result-revision: <修正後 revision>
resolved: <数値 suffix のカンマ区切り（例: 1,2）、なければ none>
dismissed: <数値 suffix のカンマ区切り、なければ none>
change-1: <変更または参照>
reason-2: <見送り理由>
verification: <実施した確認>
```

```
[VERIFIED] <結果>
result-revision: <APPLIED result-revision、指摘なしなら REVIEW-REQ revision>
resolved: <数値 suffix のカンマ区切り、なければ none>
unresolved-high-mid: <数値 suffix のカンマ区切り、なければ none>
unresolved-low: <数値 suffix のカンマ区切り、なければ none>
verification: <レビュアーが再読した対象・実行した確認>
status: <pass|unresolved>
```

`count: 0` では APPLIED を省く。その場合の VERIFIED は `result-revision` を
REVIEW-REQ の `revision` と同じにし、3つの partition はすべて `none`、
`status: pass` とする。

```
[DECISION] <未解決指摘>
result-revision: <VERIFIED result-revision>
finding-ids: <unresolved high/mid の ID>
decided-by: user
reason: <受容または再作業を選ぶ理由>
decision: <accept-risk|rework>
```

```
[HANDOFF] <タスク名>
briefing: <ファイルの絶対パス>
coordinator: <安定したペイン名>
ledger-directory: <msgs ディレクトリの絶対パス>
return-mode: <record-only | artifact-import>
return-directory: <artifact-import の場合だけ、絶対パス>
期待する成果物: <draft PR / コミット / レポート>
```

```
[FYI] <一言で内容>
<要点1〜3行>
詳細: <ファイルの絶対パス>
返信不要
```
