# Global agent instructions

Shared instructions for the LLM coding agents used on this machine —
Claude Code, OpenAI Codex, and GitHub Copilot CLI. This single file is
symlinked into each tool's global instruction path by `scripts/link`:

- Claude Code → `~/.claude/CLAUDE.md`
- Codex       → `~/.codex/AGENTS.md`
- Copilot CLI → `~/.copilot/copilot-instructions.md`

Edit this one file in the dotfiles repo to change the rules for all three.

## Claude Code: delegate implementation to subagents

Claude Code only — Codex and Copilot CLI have no equivalent and should
ignore this section.

When the main session runs on a top-tier model (Fable 5), conserve its
tokens: the main session's job is **design, task decomposition, auditing
subagent output, and code review** — not typing out routine code.

- Delegate implementation to subagents via the Agent tool with an
  explicit model override:
  - `model: "sonnet"` — routine, well-specified implementation:
    mechanical edits, boilerplate, tests, changes with a clear spec.
  - `model: "opus"` — harder but well-scoped implementation:
    multi-file refactors, non-trivial logic that a written spec can
    fully capture.
- Give each implementation subagent a precise, self-contained spec
  (files, constraints, acceptance criteria), then review its diff in
  the main session before moving on.
- Dispatch independent subtasks to subagents in parallel and keep
  working while they run; don't block on one subagent when other work
  is ready. For follow-ups in an area a subagent already knows, continue
  that subagent via SendMessage instead of spawning a fresh one — it
  keeps its context and cache.
- Verify nontrivial work with a separate fresh-context subagent checked
  against the spec, rather than relying on the implementer's own
  self-review.
- Exception: implementation that is genuinely hard — subtle algorithms,
  ambiguous requirements, or work that needs the full conversation
  context — may be done directly in the main (Fable 5) session.

## Commits and pull requests

Applies to all agents, in every repository.

- **Commits: stack them in logical, self-contained units.** Never squash a
  whole feature into one commit. Split along dependency order (e.g. spec →
  schema/migration → shared pieces → feature body + tests → docs sync); each
  commit must make sense and build on its own. Follow the repo's existing
  message conventions.
- **Pull requests: create as draft by default.** Only open a ready-for-review
  PR when explicitly asked.
- **PR body: if the repo has a PR template** (`.github/pull_request_template.md`
  or `PULL_REQUEST_TEMPLATE/`), the description must follow it — fill every
  section, and tick checkboxes only for things actually verified. Note that
  `gh pr create --body` does NOT auto-apply the template; read it and write
  the body to match.
- **PR title and description must describe the actual change** — what was done
  and why, matching the repo's title conventions. No generic or leftover text.

## Scope discipline

Applies to all agents. Don't add features, refactor, or introduce
abstractions beyond what the task requires. A bug fix doesn't need
surrounding cleanup, and a one-shot operation usually doesn't need a
helper. Don't design for hypothetical future requirements: do the
simplest thing that works well. Don't add error handling, fallbacks, or
validation for scenarios that cannot happen — trust internal code and
framework guarantees, and validate only at system boundaries (user
input, external APIs). Don't use feature flags or backwards-compatibility
shims when you can just change the code.

## Python

Python on this machine is managed by **uv**. The default `python` / `python3`
on `PATH` resolve to `~/.local/bin/python`, a uv-managed CPython installed via
`scripts/python`. Use it by default.

- Run Python through the `python` / `python3` already on `PATH`. Do **not**
  hard-code `/usr/bin/python3`, Homebrew, pyenv, or nix interpreters, and do
  not install a separate interpreter just to "get Python working".
- **A missing third-party package is not a blocker and not a reason to
  downgrade the approach.** The global interpreter is intentionally bare. If a
  task is cleaner with pandas / numpy / requests / etc., pull them in on the
  fly with uv — adding a dependency here is cheap and isolated, so do it.
  Do **not** fall back to a stdlib-only workaround to avoid a dependency
  unless the user explicitly asked to keep it dependency-free.
- One-off scripts and analysis with dependencies: run them through an
  **ephemeral uv environment**, which is fast and leaves the global
  interpreter untouched — no install step, no cleanup:
  - `uv run --with pandas --with matplotlib script.py`
  - inline: `uv run --with pandas - <<'PY'` … `PY`
  - `uvx <tool>` (= `uv tool run`) to run a Python CLI without installing it
- Project work: use `uv venv` + `uv pip install ...`, or `uv sync` when a
  `pyproject.toml` / `uv.lock` is present. Don't `pip install` into the global
  interpreter.
- Need a different Python version: `uv python install <version>`
  (`scripts/python` installs the latest and registers it as the global
  default). Don't reach for pyenv / asdf / system package managers.
