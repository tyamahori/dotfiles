---
name: agent-usage-review
description: Claude Code / Codex のセッション・トークン利用量を計測し、非効率パターン（context churn、日跨ぎ resume、低 cache hit、インライン長文貼り付け）を診断して、CLAUDE.md・config・hooks への修正を提案→承認→適用し、journal.md に記録する定期レビューサイクルの正本。「トークン利用量をチェックして」「usage review」「トークン消費を改善して」「利用量レビュー」と言われたときに使う。
---

# agent-usage-review

Claude Code / Codex のトークン利用を「計測 → 診断 → 提案 → 承認 → 適用 → 記録」の
1 サイクルで改善する。修正の着地先はこのマシンの規範ファイル
（`~/dotfiles` の CLAUDE.md・config・hooks）なので、適用には必ずユーザー承認を挟む。

このサイクルは skill 化以前に手動で 2 周回っている（journal.md 参照）。
過去サイクルの計測値と適用済み修正が journal.md にあるので、**最初に読む**。
同じ指摘を繰り返さないこと、前回修正の効果を今回の計測で検証することが目的。
journal.md は**ローカル専用**（gitignore 済み — セッション ID・コスト実測・
プロジェクト名を含むため public リポジトリに載せない）。存在しなければ
このマシンでの初サイクルとして空から始める。

## 1. 計測

```bash
bash scripts/snapshot.sh --days 7
```

出力は markdown 一枚: 日次合計（モデル別）、コスト上位セッション、警告フラグ一覧。
合計は [ccusage](https://github.com/ryoppippi/ccusage)（Claude/Codex/Grok/Qwen 対応）、
警告フラグは raw JSONL の集計。データソース:

- Claude: `~/.claude/projects/**/*.jsonl` — assistant メッセージの `.message.usage`
  （`cache_creation_input_tokens` = コンテキスト書き直し量、churn の代理指標）
- Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` — `token_count` イベントの
  `last_token_usage` を合計する。**`total_token_usage` はセッション内累積値なので
  合計すると過大計上になる**。

## 2. 診断

警告フラグと典型原因・修正の対応:

| 警告フラグ | 意味 | 典型修正 |
|---|---|---|
| `days>1` | 人間の typed prompt が日跨ぎ。毎ターン全コンテキストを cache write し直す | セッション衛生ルールの徹底・handoff 手順の改善 |
| `cacheW>1M` | context churn。compaction・長大セッション・巨大ファイルの再読込 | 早期 handoff、bulk はファイルパス渡し、read の offset/limit |
| `big_user_msgs` | 20k 字超の人間入力 = インライン貼り付け | `local://` / ファイルパス渡しの規範化 |
| `hit<70%` | Codex の cache 効率低下。並列セッションやコンテキスト作り直し | セッション構成の見直し |
| `final_ctx>200k` | コンテキスト肥大のまま完走 | 早期分割・サブエージェント委譲 |
| `idle_resumes>0` | 1時間超の中断後、200k超のcontextを再開して100k超をcache write | handoffを残して新セッションで再開 |

警告フラグが出たセッションは JSONL を直接見て原因を特定する（どのプロジェクトか、
何を貼り付けたか、churn がどのターンで起きたか）。数字だけで提案しない。

Claude の assistant レコードは1つの API message が content block ごとに複数行へ
分割されるため、usage は `.message.id` で重複排除してから集計する。期間判定も
ファイルの mtime や task notification ではなく、期間内の実イベントに限定する。

コスト上位セッションも見る: 警告フラグゼロでも「同じ調査を複数セッションで重複」
「ルーティング違反（機械的作業を高コストモデルで実行）」はここに出る。

既存の警告フラグをすり抜ける既知パターン: **常駐ワーカーの文脈累積**。定期ジョブを
受ける長寿命セッションは履歴がジョブごとに単調増加し、ターン単価が数倍に
膨らんでから autocompact に入る（days=1・cacheW 小のまま進行するので警告フラグが
出ない）。ジョブ内容が会話履歴に依存しないなら、ジョブ終端でセッションを
リセットするのが修正。疑ったらセッションのターン別 ctx 推移を直接見る。

## 3. 提案

修正案ごとに 3 点を明示し、影響度順に並べる:

1. **影響度**: 推定削減量（トークン/週 または $/週）。計測値から見積もる。
2. **根拠**: セッション ID と計測値。
3. **着地先**: 下のマップから選ぶ。

着地先マップ:

| 修正の種類 | 着地先 |
|---|---|
| エージェントの行動規範 | `dotfiles/claude/CLAUDE.md`（全 CLI 共通に symlink 済み） |
| 機械的な強制（deny 等） | `dotfiles/claude/hooks/`・settings.json の PreToolUse |
| モデルルーティング・omp 挙動 | `dotfiles/omp/config.yml`・`APPEND_SYSTEM.md`・extensions |
| 手順の正本化 | 既存 skill の更新、または新 skill |
| プロジェクト固有の原因への修正 | 当該リポジトリ側 — AGENTS.md / CLAUDE.md（規範）、`.claude/skills/`（手順・スクリプト）、`.claude/settings.json` の hooks（強制） |

原因がプロジェクト固有なら修正もそのリポジトリに落とし、一般化できた
エッセンスだけをこの skill の診断節や dotfiles の規範へ昇格する。
グローバル側に個別プロジェクトの事情を書かない。

## 4. 承認

提案を影響度順に提示し、**項目ごとに承認を取ってから**適用する。
規範ファイルを無承認で書き換えない。却下された案も journal に一行残す
（次サイクルで再提案しないため）。

## 5. 適用

CLAUDE.md への規範追加は既存スタイルに合わせ、計測値と日付を添える:
`(measured YYYY-MM-DD: <数値と事実>)`。数値の裏付けがない規範は書かない。

## 6. 記録

journal.md の先頭にエントリを追記:

```markdown
## YYYY-MM-DD
- 計測: <期間、合計、警告フラグの要約>
- 前回比: <前回適用した修正の効果。改善/悪化/判定不能>
- 適用: <修正と着地先>
- 却下: <案と理由>
```

journal は一次記録で、リポジトリは public。知見はこの二層で住み分ける:

- **journal（ローカル）**: セッション ID・金額・プロジェクト名など生の固有値。
- **公開層（コミットする）**: 固有値を落として一般化できた知見。
  新しい警告フラグパターンと典型修正は「2. 診断」の表へ、検出ロジックの改善は
  `scripts/snapshot.sh` へ、行動規範は着地先マップの規範ファイルへ昇格する。

サイクルを閉じる前に「今回の発見のうち一般化できるものはどれか」を一度問い、
昇格分をコミットする。journal に書いて終わりにしない。

前回比が「判定不能」の連続はサイクル間隔が短すぎるサイン。週 1 が目安。
