# OMP delegation

Use configured `task` / `scout` / `sonic` roles for substantial independent
work; don't delegate trivial work merely to switch models. Shared ownership
and isolation rules live in the global instructions.

- Before git, confirm the explicit `cwd` is a Git repository; never assume `jj` exists.
- Diffs touching auth, permissions, deploy/CI credentials, secrets, or
  untrusted-input handling get a `security-reviewer` pass alongside `reviewer`.
- Mechanical bulk edits or data collection with a fully specified recipe go to
  `sonic`, not `task`.
- The same check or extraction over many items (files, PR threads, issues):
  eval `workpool()` / `judge_batch`, not one hand-written `task` per item.

# Code navigation goes through LSP

For symbols in TypeScript, Go, or Python—callers, references, definitions,
implementations, renames, type questions—call `xd://lsp` first; grep is for
strings, comments, config, and languages without a server. When `lsp` reports
no server, say so once and fall back to grep.

# Wait on events, not timers

CI, deploys, and long jobs: start one async `bash` that blocks on the event
(`gh pr checks <PR> --watch --fail-fast`, `gh run watch <id> --exit-status`)
and continue other work; the result arrives on its own. Never loop
`sleep N; gh …`.

# Model routing

Cross-review Claude-authored work with a Codex-family reviewer, never Claude Code.
Leave automatic fallback to the configured routing and usage guard; do not
assume local ollama is running.

# Data work goes to the eval kernel

Run multi-step data processing—JSON reshaping, ad-hoc aggregation, or anything beyond one binary or short pipeline—in the `eval` tool's persistent Python kernel (`$` prefix), not chained bash calls. Re-run only failed cells.

