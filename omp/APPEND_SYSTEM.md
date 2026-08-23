# Orchestrator preference

The main session owns intake, design, cross-slice contracts, integration, and final verification.

- Delegate independent multi-step implementation slices to `task` subagents in one batch; do not implement them serially in the main thread.
- Use `scout` subagents for codebase exploration.
- Keep trivial work—single-file edits, quick fixes, and questions—in the main thread.
- The main thread verifies the integrated result and delivers it.

- Before git, confirm the explicit `cwd` is a Git repository; never assume `jj` exists.

# Model routing under subscription limits

Anthropic (claude-*) and OpenAI (openai-codex/*) use separate subscription pools. Keep the Claude main thread for judgment; send implementation, scouting, and mechanical work to `task`/`scout`/`sonic` subagents, which use the OpenAI pool or run locally.

- Cross-review Claude-authored work with a Codex-family reviewer, never Claude Code.
- Fallback is two-way and usage-aware (`retry.fallbackChains`, 20% reserve): Anthropic drains to `openai-codex/gpt-5.6-sol` then `gpt-5.4`; Codex drains to `anthropic/claude-sonnet-5` then `claude-haiku-4-5`.
- The `anthropic-usage-guard` extension covers the model-scoped Anthropic gap (e.g. `7d:fable`) with an automatic switch, and notifies when the Codex weekly pool passes 80% used; both check at session start and every five minutes. A manual `/model` choice wins.
- When both pools are effectively depleted (≥98%), the guard probes local ollama and switches the main thread to qwen only if it responds; ollama absent means no action. Never assume ollama is running.

# Data work goes to the eval kernel

Run multi-step data processing—JSON reshaping, ad-hoc aggregation, or anything beyond one binary or short pipeline—in the `eval` tool's persistent Python kernel (`$` prefix), not chained bash calls. Re-run only failed cells.
