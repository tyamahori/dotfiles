---
name: codex-insights
description: Codex の使い方の振り返り・診断・最近の利用分析を頼まれたとき（Claude Code の /insights 相当）に使う。ローカルセッション履歴から利用傾向・作業領域・摩擦・改善案を HTML レポートにまとめる。
---

# Codex Insights

`scripts/generate.py` で `~/.codex/sessions` と
`~/.codex/archived_sessions` の JSONL をローカル解析し、自己完結した HTML
レポートを生成する。履歴や集計値を外部へ送信しない。

## 実行

通常は直近 90 日を対象にする。

```bash
uv run scripts/generate.py
```

ユーザーが期間を指定した場合は `--days N`、全履歴なら `--all` を使う。
保存先の指定は `--output PATH`。未指定時は
`~/.local/share/codex-insights/insights-YYYY-MM-DD-HHMMSS.html` に保存され、
同じディレクトリの `report.html` も同じ内容へ更新される。

実行後は標準出力に表示されたレポートパスと、目立つ傾向を簡潔に返す。
ブラウザを勝手に起動しない。ユーザーが表示を求めた場合だけ、利用可能な
ブラウザ機能で開く。

## 境界

- 集計は Codex のローカル記録に基づく近似であり、請求額や契約上の正確な
  使用量を示すものではない。
- システム／開発者指示は分析対象の会話から除外する。
- レポートには代表的なユーザーメッセージの短い抜粋が入るため、共有前に
  内容を確認する。
- スクリプトの警告があっても、読めたセッションだけでレポートを完成させる。
