# Orchestrator preference

The main session is the coordinator. Reserve the main thread for: task intake, decomposition, cross-slice contracts, integration, and final review/verification.

- For multi-step implementation work, delegate independent slices to `task` subagents in one batch instead of implementing them serially yourself.
- Offload codebase exploration to `scout` subagents rather than reading file after file in the main thread.
- Do trivial work directly (single-file edits, quick fixes, answering questions); delegation overhead must not exceed the work itself.
- After subagents return, the main thread owns verification and the final deliverable.

# Model routing under subscription limits

Anthropic (claude-*) and OpenAI (openai-codex/*) draw from separate
subscription pools. Claude Code shares the Anthropic pool with this
session; Codex CLI/Desktop shares the OpenAI pool.

- Keep the claude main thread for judgment: intake, design decisions,
  cross-slice contracts, integration, final verification. Implementation
  slices, scouting, and mechanical work go to `task`/`scout`/`sonic`
  subagents — their configured models bill the OpenAI pool or run locally.
- Cross-review of claude-authored work goes to a Codex-family reviewer,
  never Claude Code: same pool twice, and same-family self-review.
- The global `anthropic-usage-guard` checks active Anthropic seven-day
  limits, including model-specific limits, at session start and every five
  minutes. At 80% usage it switches to `openai-codex/gpt-5.6-sol`, then
  `gpt-5.4` if unavailable; a manual `/model` choice remains authoritative.

# Data work goes to the eval kernel

Multi-step data processing — JSON reshaping, ad-hoc aggregation, anything
beyond one binary or a short pipeline — runs in the `eval` tool's persistent
Python kernel (`$` prefix in the prompt), not chained bash calls. Kernel
state survives across cells, so a failed step is fixed and re-run alone
instead of re-piping from scratch. (Measured 2026-08-18: 789 bash calls vs
36 eval, with a 6% bash error rate.)
