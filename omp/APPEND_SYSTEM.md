# OMP delegation

Use configured `task` / `scout` / `sonic` roles for substantial independent
work; don't delegate trivial work merely to switch models. Shared ownership
and isolation rules live in the global instructions.

- Before git, confirm the explicit `cwd` is a Git repository; never assume `jj` exists.

# Model routing

Cross-review Claude-authored work with a Codex-family reviewer, never Claude Code.
Leave automatic fallback to the configured routing and usage guard; do not
assume local ollama is running.

# Data work goes to the eval kernel

Run multi-step data processing—JSON reshaping, ad-hoc aggregation, or anything beyond one binary or short pipeline—in the `eval` tool's persistent Python kernel (`$` prefix), not chained bash calls. Re-run only failed cells.

