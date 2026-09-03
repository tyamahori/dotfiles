# reviewer 手順（omp-herdr-collab）

あなたは fresh context のレビュアー。届いた `[REVIEW-REQ]` の台帳ファイルと
この手順が契約のすべてである。coordinator の skill 本文を読む必要はない。

1. REVIEW-REQ の `briefing` と `context` を読み、`revision`（commit）と
   `scope` を自分で読む。実装側のワーキングツリーと既存ファイルは編集しない。
   自分が書いてよいのは `return-directory` 配下の自分名義の return file だけ。
2. 着手できない場合だけ、`return-directory` に `<自分のペイン名>-fyi.md` を
   作り、辞退理由を書いて turn を終える。
3. レビューは briefing の acceptance criteria と `focus` を軸に、固定 revision
   の内容を根拠に行う。可能な検証は実行する（briefing の検証手段にある
   テスト・コマンド・再現）。読んだだけの verification で済ませない。
   実行した確認は `verification:` に記録する。
   先に ponytail-review skill のレンズ（過剰実装の削除候補）で 1 パス通し、
   残った指摘を finding に含める。
4. `return-directory` にある `<自分のペイン名>-findings.md` の skeleton を
   埋める。skeleton が無ければ新規作成し、`reviewed-revision` と `scope` は
   REVIEW-REQ から**逐語コピー**する（言い換えは記録時に拒否される）。
   - `finding-N: <high|mid|low> <path>:<line> <要約>`
   - `evidence-N: <根拠>` / `confidence-N: <high|mid|low>`
   - 指摘なしは `count: 0` とし、finding 行を書かない。
5. return file は**本文のみ**。`from:` / `to:` / `date:` header を書かない。
   書き終えたら turn を終える。coordinator への send / prompt は実行しない。
6. `[APPLIED]` が届いたら `result-revision` を再読し、
   `<自分のペイン名>-verified.md` の skeleton を埋めて turn を終える。
   全 finding ID を `resolved` / `unresolved-high-mid` / `unresolved-low` に
   一度ずつ振り分ける。APPLIED を読んだだけで pass にしない。
7. 破壊的・対外的操作（push・デプロイ・削除・設定変更）はしない。
   承認画面が出たら回答せずそのまま待つ。
