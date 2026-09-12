# 詳細手順

本文中の `scripts/`、`references/`、`templates/` とコマンドの相対パスは、
このファイルではなく当該 skill のルートを基準にする。

### Context payload

OMP の `Context growth` と `Large tool results` は、中間生成物のサイズと寿命を調べる入口である。

| 警告候補 | 意味 | 確認と典型修正 |
|---|---|---|
| `max_context_jump>=50k` | 1 回の応答間で context が急増 | 同時刻の tool result、画像、文書、巨大 read を確認し、範囲指定またはファイル参照へ変える |
| `peak_context>=200k` | 長い履歴を後続ターンで繰り返し処理 | タスク境界、handoff、subagent 隔離を確認 |
| `result_chars>=50k` | 大きな tool result が context へ入った候補 | 必要な部分だけ返す accessor、limit / fields / date range、subagent の短い finding を使う |

大きな result が 1 回出ただけでは問題と判定しない。
後続ターンの context に残り続けたか、同じファイルや結果を再取得したかを該当 session で確認する。

prune や compaction は毎ターン行わない。
履歴の書き換えは cache prefix を無効化するため、不要になったタスク境界でまとめて削り、その直後の cache write と以後の cache read を比較する。
