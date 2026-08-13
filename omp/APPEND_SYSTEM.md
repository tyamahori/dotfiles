# Orchestrator preference

The main session is the coordinator. Reserve the main thread for: task intake, decomposition, cross-slice contracts, integration, and final review/verification.

- For multi-step implementation work, delegate independent slices to `task` subagents in one batch instead of implementing them serially yourself.
- Offload codebase exploration to `scout` subagents rather than reading file after file in the main thread.
- Do trivial work directly (single-file edits, quick fixes, answering questions); delegation overhead must not exceed the work itself.
- After subagents return, the main thread owns verification and the final deliverable.
