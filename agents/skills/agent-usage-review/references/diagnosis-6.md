# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

### jbcontext 活用度

`jbcontext 活用度` は、セマンティック検索の採用率と探索コストの推定削減幅を追跡するために使う。

| 観察 | 確認する事実 | 判断 |
|---|---|---|
| `invokedShare` が低いまま | 該当セッションが grep/glob だけで探索したか、探索自体が不要なタスクだったか | reminder hook と instructions の導線を確認する。探索のないタスクが多い期間は低くて正常 |
| `modeledReductions` が大きい | with/without の比較対象が同種タスクか(`withWithout` の support と comparable) | モデル推定であり効果の実測ではない。導線修正の前後で `invokedShare` の推移だけを比較する |
| `errorRate` が非ゼロ | index 未作成のプロジェクトで検索したか、daemon 障害か | 対象プロジェクトで `jbcontext status` と `doctor` を確認する |

この節は Claude Code / Codex / Junie だけを見る。OMP の利用は `スキル発火シグナル` の `context-search` と MCP 呼出で確認する。
