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
- Prefer a fresh session with a handoff file over resuming a long-lived
  session across days. A resumed mega-session pays full-context cache
  reads and re-writes on every turn; hand off, then start clean.
