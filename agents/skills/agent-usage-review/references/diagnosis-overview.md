# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

## 2. 診断

まず snapshot、journal、設定、該当セッションを突き合わせる。

数値だけで設定を変えない。

数値を根拠にする前に、何を数えたかを確かめる。
手で検算するなら、snapshot と同じデータソース、重複排除、期間境界をそろえる。
期間はローカル時刻の日付境界から始まる（`scripts/snapshot.sh` の `CUTOFF_EPOCH`）。
食い違えば、まず検算側を疑う。
前回の journal との差が週ごとの揺れより小さければ、変化と呼ばない。
観点の一覧は `diagnosing-bugs` の「Vet the number before you trust it」にある。

警告フラグが出たセッションは JSONL を直接見て、どの作業、入力、ターン、再開、委譲が原因かを特定する。

OMP の提案では、該当 session、実際に読まれた設定、起動から tool 実行までの経路も確認する。
