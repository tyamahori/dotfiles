# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

## 2. 診断

まず snapshot、journal、設定、該当セッションを突き合わせる。

数値だけで設定を変えない。

数値を診断や提案の根拠にする前に、その数値が何を数えたかを確かめる。
手で検算するときは snapshot と同じデータソース、重複排除、期間境界を使う。
snapshot の期間はローカル時刻の日付境界から始まる（`scripts/snapshot.sh` の `CUTOFF_EPOCH`）。
検算と snapshot が食い違ったら、検算側の条件のずれを先に疑う。
前回 journal との差が週ごとの揺れより小さいなら、変化とは呼ばない。
観点の一覧は `diagnosing-bugs` の「Vet the number before you trust it」にある。

警告フラグが出たセッションは JSONL を直接見て、どの作業、入力、ターン、再開、委譲が原因かを特定する。

OMP の提案では、該当 session、実際に読まれた設定、起動から tool 実行までの経路も確認する。
