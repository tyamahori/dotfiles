---
name: agent-usage-review
description: 「トークン利用量をチェックして」「usage review」「利用量レビュー」「omp-review」と言われたときに使う。Claude Code・Codex・OMP の利用量と実行経路を週次で計測して非効率を診断し、承認後に適用して journal に記録する。
---

# agent-usage-review

Claude Code、Codex、OMP の利用を、原則週 1 回の「計測 → 診断 → 提案 → 承認 → 適用 → 検証 → 記録」で改善する。

OMP では人間が任意の cwd から `omp-review [--days N]` を実行する。

`omp-review` は新しい人間向け TUI を起動し、指定された過去 $N$ 日（正の整数、指定がなければ 7 日）の review をこの skill に渡す。

修正の着地先はこのマシンの規範ファイル（`~/dotfiles` の CLAUDE.md、config、hooks、OMP 設定、plugins）なので、適用には必ずユーザー承認を挟む。

自動適用はしない。

## 0. 前回の記録を読む

このサイクルは開始前に `~/dotfiles/agents/skills/agent-usage-review/journal.md` を読む。

同じ指摘を繰り返さず、前回適用した修正が今回の計測期間で効いたかを検証するためである。

journal がなければ、このマシンでの初回として空から始める。

journal はローカル専用である。

セッション ID、費用実測、プロジェクト名などを含みうるため、public な dotfiles リポジトリへ載せない。

## 1. 計測

`omp-review` から受け取った日数で snapshot を作る。

```bash
bash ~/dotfiles/agents/skills/agent-usage-review/scripts/snapshot.sh --days N
```

snapshot は Markdown 一枚を stdout に出す。

snapshot に会話本文や認証情報を混ぜない。
ローカル診断では session ID、費用、ローカルパスを扱い、必要なら journal に記録する。
これらの固有値は public なコミット、共有物、会話への貼り付けから除く。

出力は日次合計（モデル別）、コスト上位セッション、警告フラグ、cache 構成、ターン別 context 増分、大きな tool result、スキル発火シグナル、常駐指示と外部記憶のサイズを含む。

合計は [ccusage](https://github.com/ryoppippi/ccusage)（Claude、Codex、Grok、Qwen 対応）、警告フラグは raw JSONL、OMP 固有指標は `~/.omp/stats.db` と session event の集計で得る。

データソース:

- Claude: `~/.claude/projects/**/*.jsonl` の assistant メッセージにある `.message.usage`。
  `cache_creation_input_tokens` はコンテキスト書き直し量であり、churn の代理指標となる。
- Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` の `token_count` イベントにある `last_token_usage`。
  `total_token_usage` はセッション内累積値なので、合計すると過大計上になる。
- OMP: `~/.omp/stats.db` の正規化済み message / tool call と、session event、設定、plugin、patch。
  fresh input、cache read/write、価格表換算、ターン別 context、tool result size を分けて扱う。
  OMP 固有の数値がない項目は、実動経路と設定の照合で評価する。
- 外部記憶: OMP の namespace、Claude Code の project memory、Codex の memory file / DB。
  file / byte / record 数は期間集計ではなく snapshot 時点の値であり、本文は出力しない。

Claude の assistant レコードは 1 つの API message が content block ごとに複数行へ分割されるため、usage は `.message.id` で重複排除してから集計する。

期間判定もファイルの mtime や task notification ではなく、期間内の実イベントに限定する。

スキル発火シグナルは、各 CLI の明示的な起動記録、または `SKILL.md` / `skill://` の読込イベントから集計する。
skill listing、会話内の名前への言及、tool result に含まれる skill 本文は数えない。
出力するのは agent、skill 名、発火回数、該当セッション数、シグナル種別だけとし、会話本文、tool 引数、ファイルパス、session ID は出力しない。
Codex と OMP の `skill_file_read` は読込の証拠であり、手順を最後まで実行した証拠ではない。

## 診断の読込経路

週次の全体レビューでは以下の全分野を確認する。対象を限定した診断では概要と関連分野だけを読む。
同条件の既存 snapshot と journal を再利用し、不足する根拠だけ補う。

- [2. 診断](references/diagnosis-overview.md)
- [コストと品質](references/diagnosis-1.md)
- [実行効率](references/diagnosis-2.md)
- [Claude Code と Codex](references/diagnosis-3.md)
- [Context payload](references/diagnosis-4.md)
- [スキル利用](references/diagnosis-5.md)
- [jbcontext 活用度](references/diagnosis-6.md)
- [OMP](references/diagnosis-7.md)
- [外部記憶](references/diagnosis-8.md)
- [外部追随](references/diagnosis-9.md)

## 提案から記録まで

[承認・適用・検証・記録](references/approval-and-recording.md)を提案前に読む。
規範・設定・plugin の変更は項目別承認後だけ行い、実動確認とローカル journal への記録で閉じる。
