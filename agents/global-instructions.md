# Global agent instructions

Shared instructions for the LLM coding agents used on this machine —
Claude Code, OpenAI Codex, and GitHub Copilot CLI. This single file is
symlinked into each tool's global instruction path by `scripts/link`:

- Claude Code → `~/.claude/CLAUDE.md`
- Codex       → `~/.codex/AGENTS.md`
- Copilot CLI → `~/.copilot/copilot-instructions.md`

Edit this one file in the dotfiles repo to change the rules for all three.

## Python

Python on this machine is managed by **uv**. The default `python` / `python3`
on `PATH` resolve to `~/.local/bin/python`, a uv-managed CPython installed via
`scripts/python`. Use it by default.

- Run Python through the `python` / `python3` already on `PATH`. Do **not**
  hard-code `/usr/bin/python3`, Homebrew, pyenv, or nix interpreters, and do
  not install a separate interpreter just to "get Python working".
- One-off scripts that need dependencies: prefer `uv run script.py`
  (or `uv run --with <pkg> ...`) over hand-rolled virtualenvs.
- Project work: use `uv venv` + `uv pip install ...`, or `uv sync` when a
  `pyproject.toml` / `uv.lock` is present. Don't `pip install` into the global
  interpreter.
- Need a different Python version: `uv python install <version>`
  (`scripts/python` installs the latest and registers it as the global
  default). Don't reach for pyenv / asdf / system package managers.
