# model migration journal

新しいサイクルを上に追記。書式は SKILL.md「記録」を参照。

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
- 検証: 別の新セッションで skill 発火を確認し、22:01 に `scripts/model-pins ack`
  実行。`check` は差分なし(exit 0)。基準値は `plan: ...:medium` を含む現在値。
- 1週間後:

## YYYY-MM-DD <from> → <to>

- 契機:
- 読んだソース(URL・取得日):
- 提案:
- 適用:
- 却下・保留:
- 検証:
- 1週間後:
