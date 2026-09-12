# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

### Claude Code と Codex

| 警告フラグ | 意味 | 典型修正 |
|---|---|---|
| `days>1` | 人間の typed prompt が日跨ぎ。毎ターン全コンテキストを cache write し直す | セッション衛生ルールの徹底、handoff 手順の改善 |
| `cacheW>1M` | context churn。compaction、長大セッション、巨大ファイルの再読込 | 早期 handoff、bulk はファイルパス渡し、read の offset/limit |
| `big_user_msgs` | 20k 字超の人間入力。インライン貼り付け | `local://` またはファイルパス渡しの規範化 |
| `hit<70%` | 100k tokens 超を処理した Claude / Codex セッションの cache read 率低下 | fresh/cache の内訳、prefix の変化、並列セッション、compaction、model 切替を確認 |
| `models>1` | 同一の長大 Claude context で model string が変化。cache reset の候補 | 品質上必要な切替か、別セッションへ分離できるかを確認 |
| `final_ctx>200k` | コンテキスト肥大のまま完走 | 早期分割、サブエージェント委譲 |
| `idle_resumes>0` | 1 時間超の中断後、200k 超の context を再開して 100k 超を cache write | handoff を残して新セッションで再開 |

コスト上位セッションも確認する。

警告フラグがなくても、同じ調査を複数セッションで重複した場合や、機械的作業を高コストモデルで実行したルーティング違反はここに現れる。

既存の警告フラグをすり抜ける既知パターンは、常駐ワーカーの文脈累積である。

定期ジョブを受ける長寿命セッションは履歴がジョブごとに単調増加し、ターン単価が数倍に膨らんでから autocompact に入る。

`days=1` と `cacheW` 小のまま進行するため、疑ったらセッションのターン別 context 推移を直接見る。

ジョブ内容が会話履歴に依存しないなら、ジョブ終端でセッションをリセットする。
