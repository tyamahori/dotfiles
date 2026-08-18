# usage review journal

新しいサイクルを上に追記。書式は SKILL.md「6. 記録」を参照。

## 2026-08-18（手動サイクル、skill 化以前）
- 計測: bash 789 回 vs eval 36 回、bash エラー率 6%。
- 適用: omp `APPEND_SYSTEM.md` に「Data work goes to the eval kernel」を追加。

## 2026-08-16（手動サイクル、skill 化以前）
- 計測: resume したセッション 1 本が Anthropic 週次クォータの 64% を消費、
  うち半分が compaction churn。
- 適用: CLAUDE.md「Session hygiene under subscription limits」に 3 ルールを追加
  （日跨ぎ resume 禁止・compaction 連発で即 handoff・bulk はファイルパス渡し）。
