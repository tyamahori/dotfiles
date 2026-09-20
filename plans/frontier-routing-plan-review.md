# 計画・レビュー時のフロンティアモデル利用の見直し

## Context

`omp/config.yml` のモデルルーティングを確認した結果、現状はすでに以下の通り:

- `modelRoles.plan: openai-codex/gpt-6-astra:low` — 計画立案はフロンティア(Astra)だが `:low` 修飾子で推論エフォート抑制。
- `modelRoles.slow: openai-codex/gpt-6-astra` — フルエフォートのAstra。
- `task.agentModelOverrides.reviewer: "@slow"` / `security-reviewer: "@slow"` — レビュー系サブエージェントは `@slow` ロール解決でフルエフォートAstraを使用済み。
- `retry.fallbackChains.openai-codex/gpt-6-astra: [anthropic/claude-fable-5-1]` — Astra depletion時のみFableへフォールバック。

つまり「レビュー」はすでにフルエフォートのフロンティア(Astra)に当たっている。「計画」はフロンティアではあるが `:low` エフォートで動いている。ユーザーの意図が「計画・レビュー時は最上位品質で」なのか「計画のコスト効率は今のままでよい」のかで対応が変わる。

## Approach

`modelRoles.plan` の `:low` を外し、`slow` と同じフルエフォート `openai-codex/gpt-6-astra` にする(ユーザー確認済み: 計画品質優先、コスト増は許容)。レビュー系(`reviewer`, `security-reviewer`)は変更不要(既に `@slow` でフル)。

## Files to modify

- `omp/config.yml` (`modelRoles.plan`)

## Reuse

- 既存の `slow` ロール定義をそのまま踏襲(新規ロール追加なし)。
- `task.agentModelOverrides` の `reviewer`/`security-reviewer` は変更なし(既に要件を満たす)。

## Steps

- [ ] `modelRoles.plan` を `openai-codex/gpt-6-astra:low` → `openai-codex/gpt-6-astra` に変更
- [ ] コメントで意図(計画品質優先、フルエフォート)を残す

## Verification

- `omp -p --no-session` で plan ロール解決を確認(または次回のPlan Mode起動時にバッジ表示 `showResolvedModelBadge` で確認)。
- 設定変更後、稼働中のOMPセッションに再起動が必要な旨をユーザーに伝える(dotfiles AGENTS.md既定)。
