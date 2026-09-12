# model migration journal

新しいサイクルを上に追記。書式は SKILL.md「記録」を参照。

## 2026-09-13 指示レビューの承認項目を適用

- 根拠: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra と既存の Codex・Claude 履歴。調査範囲と限界は `.agent-msgs/scratch/2026-09-13-instruction-audit.json`。
- 承認: 提案1〜4に対するユーザーの「すすめて」。任意案の PR 応答の承認境界は変更しない。
- 適用: AGENTS の引き継ぎ先を `.agent-msgs/handoff/` に統一。モデル移行レビューを差分中心にし、3 skill の詳細を references へ移動。PR レビューと Codex HTML レポートの発火条件を限定。
- 保持: docs/ops の保護、モデルピン、PR 応答の項目別承認、安全・品質条件。vendored natural-japanese の差分は local.patch に含めた。
- 検証: Bun 29 pass / 0 fail、SonarQube Gate passed。上流基準へ local.patch を適用し、入口と新規4参照の完全一致を確認。新規 OMP セッションで5 skill と詳細参照を読み、quick/full/score と依頼別の振り分けを確認した。
- 証跡: `.agent-msgs/scratch/2026-09-13-skill-verification.json`。lint の均質なリズム等の指摘は手順文と原文保持のため残し、追加した対比表現だけを修正した。
- 未計測: 実利用のトークン削減と品質同等性。入口のバイト数減少をその代用にはしない。次回利用量レビューで再読回数・誤発火・必要な手順の読込漏れを確認する。

## 2026-09-12 Astra plan の low を検証し、レビュー済み基準へ反映

- 対象: `omp.modelRoles.plan` の `openai-codex/gpt-6-astra:medium` → `:low`。
  9月10日の承認済み変更（`5e7d66e`）を確認した。他のピンは差分なし。
  開始時の基準ファイルは `medium` で、9月11日の記録とは一致していなかった。基準が変わった経緯は未調査。
- 公式資料（取得日はいずれも2026-09-12）:
  - https://developers.openai.com/api/docs/models/gpt-6-astra.md — `low` と `medium` は対応値。
  - https://developers.openai.com/api/docs/guides/reasoning.md — 低い effort は速度とトークン消費を優先し、高い effort は品質を優先する。ローカルでの品質同等性は示さない。
  - https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md — `none` / `minimal` 以外からは実効 effort の維持を推奨。`medium` → `low` は必須移行ではなく、消費を抑えて様子を見る運用判断。
  - https://developers.openai.com/codex/config-reference → https://learn.chatgpt.com/docs/config-file/config-reference — `model_reasoning_effort` の対応値に `low` と `medium` を掲載。
- 取得の制限: scout の `ax agent-context` はIDEの対象プロジェクト制限とタイムアウトで実行できず、専用 read で取得した。公式URLの取得失敗はなし。
- 提案・採否: 設定・指示・Skillの変更提案なし。承認済みの `low` を維持する。効果の確定は計測待ちとし、他ロールへ展開しない。
- 規範の棚卸し: 共通指示、OMP追記、管理下の22 Skillを規範群ごとに照合した。
  - マシンの事実、実測ルール、書き手の好みは維持。eval利用は `5e3f8e8`、セッション中のモデル・effort切替を避ける規範は `7a818bd` に独立した導入理由があり、今回の effort 変更だけでは削除しない。
  - `7b92c8d` の進捗・スコープ規範、`a33d261` の散文・停止原因・検証規模、`3916775` の着手判断は、現在も使うFable／Astraへの対応。旧モデルだけの回避策と判断できず、削除は保留。
  - 上流から取り込んだ文章規範の個別理由や、コミット本文のない `7d51b49`・`34ad63c` で説明できない規範は保留。全規範の追加理由を確認できたとは扱わない。
- 実動確認: 新規OMPプロセス（18.1.17）の `omp config get modelRoles --json` で plan が `:low`。
  続けて `omp --mode rpc --no-session --model @plan --no-title` を起動し、`get_state` が `openai-codex/gpt-6-astra` / `thinkingLevel: low` を返した。
  新規セッションのコマンド一覧に `skill:model-migration-review` があり、system promptにも掲載されていた。メッセージ数は0で、モデルへ推論要求は送っていない。
  短縮版 `# OMP delegation` の読込みも確認した。検証用プロセスは終了済み。
- 基準更新: 検証後に `scripts/model-pins ack` を実行。直後の `scripts/model-pins check` は差分なし（exit 0）。
- 1週間後: 9月17日以降、`agent-usage-weekly` の同種タスクについて、変更前（9月3〜9日）と変更後（9月10〜16日）の成功タスク当たり総トークン、再試行、再作業、利用枠の減少を比較する。
  9月12日の指示短縮も比較条件を変えるため、effort単独の効果とは断定しない。数値不足や品質悪化の判定不能は効果不明とし、悪化を確認した場合も復帰対象を提示して承認を得る。

## 2026-09-11 ack マーカー消失の復旧(新規レビューなし)

- 契機: post-commit hook が全ピンを `(none) -> 現在値` と報告(`scripts/model-pins check` exit 1)。原因は `~/.local/state/model-migration/last-reviewed.tsv`(machine-local、git 管理外)が消えていたこと。実際のモデルピン変更は無し。
- 照合: `scripts/model-pins show` の現在値を本 journal の 2026-09-05・2026-09-10 エントリの適用結果と1件ずつ突き合わせ、全項目が一致(claude=claude-fable-5-1、codex=gpt-6-astra/low、omp.modelRoles.default=anthropic/claude-fable-5-1、plan=...:low、他ロールは 09-05 基準のまま変更なし)。収集・提案・承認の新サイクルは不要と判断。
- 適用: なし(指示文・設定への変更なし)。
- 検証: `scripts/model-pins ack` でマーカーのみ再作成。直後の `scripts/model-pins check` は差分なし(exit 0)。
- 1週間後: 対象なし(ピン変更なしのため)。

## 2026-09-10 Astra plan の effort を low に変更

- 承認済み変更: `omp.modelRoles.plan` の `gpt-6-astra:medium` → `gpt-6-astra:low`。消費を抑えるためのユーザー指定。他ロールと指示文は変更しない。
- 公式資料（2026-09-10取得）: https://developers.openai.com/api/docs/guides/reasoning 。低い effort は速度とトークン節約を優先する。`medium` が `xhigh` より消費するという一般則は確認できない。
- 公開検索: Astra、medium、xhigh、usage と Reddit／X を検索したが、該当する比較投稿を特定できなかった。消費逆転の主張は計測待ちとする。
- 検証: 設定変更のみ。新しい OMP セッションでの解決済みロールと消費削減効果は未確認。再起動後に確認する。既存の未確認ピンを含むため `model-pins ack` は実行しない。
- 1週間後: 同条件のタスクで総トークン・再試行数・利用枠の減少を比較する。現時点では効果不明。

## 2026-09-05 claude-fable-5-1 / gpt-6-astra (初回・基準づくり)

- 契機: ループ新設。直前の切替は omp `default` → `claude-fable-5-1:high`、
  codex `model` → `gpt-6-astra`(`model_reasoning_effort = low`)、omp
  `plan`/`slow` → `gpt-6-astra`。`scripts/model-pins` の基準はまだ無く、
  `check` は全ピンを `(none) ->` で報告。
- 読んだソース(取得日 2026-09-05): Anthropic models overview、fable-5-1
  overview / migration-guide / whats-new、prompting-claude-fable-5-1、
  claude-prompting-best-practices、Claude Code CHANGELOG。OpenAI
  models/gpt-6-astra、guides/latest-model、guides/reasoning、API changelog、
  Codex CLI changelog、Codex config-reference。未取得: Codex config-reference
  に `model_reasoning_effort` の項・既定値なし。`ax` は使えず URL 直読みで代替。
- 提案:
  - 機械的(照合結果は全て変更なし): Fable 5.1 の `tool_choice` any/tool 拒否、
    adaptive thinking 固定(手動 budget は 400)は dotfiles に該当設定なし。omp は
    `defaultThinkingLevel: auto` / `autoThinkingMaxEffort: high` で整合。Astra の
    `none` effort 廃止・temperature/top_p 非対応は codex `low` で抵触なし。
  - 判断: (1) omp `modelRoles.plan: openai-codex/gpt-6-astra` に effort 指定
    なし。公式 reasoning ガイドは複雑な計画・判断に medium を推奨。`:medium`
    を付けるか。(2) Fable prompting は独立ツール呼出しの batch 化を推奨。omp の
    system prompt は既に指示済み、`agents/global-instructions.md` には無い。
    Claude Code / Codex 向けに1行足すか。(3) codex `model_reasoning_effort =
    low` は移行ガイド「現在の実効 effort を維持」を根拠に据え置き(config.toml
    のコメントに理由あり)。(4) Fable の「長いツール作業で進捗更新が少ない」は
    global-instructions「Say what you're doing, then recap」で既に対処済み。
  - 計測待ち: Astra の「指示ファイルへの感度上昇・詳細な整形・subagent 委譲の
    減少・テスト範囲の拡大」、Fable 5.1 の長時間 agentic 作業の改善。
    `agent-usage-weekly` の Codex tool call 数・テスト実行回数・subagent 起動
    数、常駐指示サイズの影響を次週に見る。
- 適用(承認済み): (1) omp `modelRoles.plan` を `openai-codex/gpt-6-astra:medium`
  に変更。(2) `agents/global-instructions.md` Working style に「Batch independent
  tool calls」を追加。(3)(4) は据え置き。
- 却下・保留: 25k token の reasoning/output 予約は API 利用者向けで CLI では
  対象外。Codex CLI 0.153.1-0.153.4 の Astra 修正は適用済み版で確認のみ。
  09-07 追記(保留): reviewer(`@slow` → astra、effort 未指定=medium)を
  reasoning guide の「code/security review は xhigh」に合わせ `slow: ...:xhigh`
  にするか。`task` の astra 化と同じ週次数値で判断する。役割分担そのものは
  公式特性と整合(default=fable は委譲・推測方針に合う、plan=medium 推奨どおり)。
- 検証: 別の新セッションで skill 発火を確認し、22:01 に `scripts/model-pins ack`
  実行。`check` は差分なし(exit 0)。基準値は `plan: ...:medium` を含む現在値。
  09-09 追記(適用): 上の「`defaultThinkingLevel: auto` で整合」は誤記。
  `default: ...:high` のサフィックスが auto を上書きし、直近セッションは
  configured=high 固定だった(session jsonl の `thinking_level_change`)。
  ClaudeDevs の cost 記事(effort をタスクに合わせる)を機に `:high` を外し、
  auto + `autoThinkingMaxEffort: high` を実際に効かせる。cache hit は既に
  cacheRead ≫ input で問題なし。Claude Code / Codex 側は変更なし
  (Fable 5.1 は effortLevel 未設定=high が公式既定、Astra は対象外)。
  09-10 追記(適用): Anthropic の cost 最適化 3 資料(cookbook cost-optimization、
  docs optimizing-for-cost-and-intelligence、blog reducing-cost)を dotfiles と
  照合。Fable 5.1 は DRB-II で low/medium/high の品質差がほぼ無く費用だけ
  約 1.5 倍に増える公表値があり、「自分のモデルで測れ」とある。Claude Code の既定 effort を
  `claude/settings.json` の `effortLevel: medium` に置き、settings.local.json の
  `high` を外した。cache 衛生の 1 行(mid-session の `/model` `/effort` 切替禁止)
  を global-instructions に追加。指示文の強調語監査・MCP tool 定義の遅延読込・
  安価モデルへの委譲は既存設定で充足、変更なし。
- 1週間後: agent-usage-review で Claude Code の成功タスク当たりコスト・turns・再作業を
  `high` 期(〜09-09)と比較し、悪化なら `effortLevel` を戻す。

## YYYY-MM-DD <from> → <to>

- 契機:
- 読んだソース(URL・取得日):
- 提案:
- 適用:
- 却下・保留:
- 検証:
- 1週間後:
