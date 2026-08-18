# Orchestrator preference

The main session owns intake, design, cross-slice contracts, integration, and final verification.

- Delegate independent multi-step implementation slices to `task` subagents in one batch; do not implement them serially in the main thread.
- Use `scout` subagents for codebase exploration.
- Keep trivial work—single-file edits, quick fixes, and questions—in the main thread.
- The main thread verifies the integrated result and delivers it.

# Model routing under subscription limits

Anthropic (claude-*) and OpenAI (openai-codex/*) use separate subscription pools. Keep the Claude main thread for judgment; send implementation, scouting, and mechanical work to `task`/`scout`/`sonic` subagents, which use the OpenAI pool or run locally.

- Cross-review Claude-authored work with a Codex-family reviewer, never Claude Code.
- `anthropic-usage-guard` checks active seven-day Anthropic and model-specific limits at session start and every five minutes. At 80% usage, it switches to `openai-codex/gpt-5.6-sol`, then `gpt-5.4` if unavailable; a manual `/model` choice wins.

# Data work goes to the eval kernel

Run multi-step data processing—JSON reshaping, ad-hoc aggregation, or anything beyond one binary or short pipeline—in the `eval` tool's persistent Python kernel (`$` prefix), not chained bash calls. Re-run only failed cells.
