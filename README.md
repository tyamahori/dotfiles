# dotfiles

tyamahori's macOS setup.

## Setup

```bash
git clone https://github.com/tyamahori/dotfiles.git ~/project/dotfiles
cd ~/project/dotfiles
./scripts/setup
```

`scripts/setup` runs the following in order:

1. `scripts/init` — install Homebrew, Nix, Devbox, and `gh` extensions
2. `scripts/link` — symlink dotfiles into `$HOME`, global gitignore into `$HOME/.config/git/ignore`, Claude Code settings (`claude/settings.json`, machine-local overrides go to the gitignored `~/.claude/settings.local.json`) into `$HOME/.claude/settings.json`, and shared agent instructions (see below) into each LLM CLI's config
3. `scripts/apps` — `brew bundle --global` from `~/.Brewfile`
4. `scripts/devbox` — install global devbox packages (php, go, direnv, bun, git, nodejs, mas, httpie, cmake, curl, task, uv)
5. `scripts/python` — install the latest CPython via `uv` and register it as the global `python` / `python3`

## Agent instructions

`agents/global-instructions.md` is a single set of guidance for the LLM coding
CLIs on this machine (Claude Code, OpenAI Codex, GitHub Copilot CLI). `scripts/link`
symlinks it into each tool's always-loaded global instruction file:

- Claude Code → `~/.claude/CLAUDE.md`
- Codex       → `~/.codex/AGENTS.md`
- Copilot CLI → `~/.copilot/copilot-instructions.md`

Edit that one file to change the rules for all three. It currently tells the
agents to default to the uv-managed Python (`scripts/python`) rather than system,
Homebrew, or nix interpreters.

### efficient-python skill & quarterly review

How the agents use Python is governed by the `efficient-python` skill
(`agents/skills/efficient-python/`), written 2026-07 from an audit of real
session logs to cut token waste (bare-python denials, missing-module retries,
re-running failed commands unchanged). Because its advice can rot as uv and
the ecosystem move, a self-checking loop keeps it honest:

- **`scripts/audit-python-usage`** — re-runs the audit over
  `~/.claude/projects` transcripts any time; fixed-schema JSON to stdout,
  `--save` archives a snapshot to `~/.local/state/python-usage-audit/` and
  prints a delta vs the previous one. This is how to tell whether the skill
  is actually improving agent behavior.
- **`launchd/com.tyamahori.python-skill-review.plist`** (linked & loaded by
  `scripts/link`) fires **`scripts/python-skill-review`** quarterly
  (Jan/Apr/Jul/Oct 15th, 09:47; a sleeping Mac runs it on wake). It runs a
  headless `claude -p` that re-audits, checks uv release notes, and writes a
  **proposal-only** report (no files are edited) to
  `~/.local/state/python-usage-audit/review-YYYY-MM-DD.md`, announced via a
  macOS notification.
- **When the notification appears**: read the report; if it proposes skill
  changes, apply the ones you agree with to
  `agents/skills/efficient-python/SKILL.md` (or hand the report to an agent
  session) and commit. Applying is deliberately manual.
- Run `./scripts/python-skill-review` (or `launchctl kickstart
  gui/$(id -u)/com.tyamahori.python-skill-review`) to trigger a review
  off-schedule.

### Agent collaboration (agmsg pairing)

Added 2026-07: the agents collaborate over
[agmsg](https://github.com/fujibee/agmsg) (a shared local SQLite inbox)
instead of you copy-pasting between sessions. Human cheat-sheet — what to
run and say; the agents handle the rest:

- **Once per project**: run `~/dotfiles/scripts/agmsg-pair`
  (`--with-copilot` to include Copilot CLI). It joins a team named after
  the repo with type-based identities (`claude` / `codex` / `copilot`)
  and sets delivery modes (claude-code `both`, others `turn`).
  Idempotent; safe to re-run.
- **Then just ask an agent in plain words**:
  - 「Codex にレビューさせて」 — one-shot goes headless (`codex exec`),
    multi-turn goes `[REVIEW-REQ]` → `[FINDINGS]` → `[APPLIED]` over agmsg.
  - 「Codex が実装、Claude がレビューで」 — roles are assigned per task,
    either direction works.
  - 「この調査結果を Codex に共有して」 — `[FYI]` with a file reference.
  - 「このタスクを Codex に渡して」 — `[HANDOFF]` with a briefing file.
- **Idle peers are woken automatically**: the sending agent spawns the
  peer via `agmsg spawn` (a new terminal window, or tmux pane inside
  tmux). Close the spawned window once the round-trip is done.
- **Inspect a conversation**: `/agmsg history` (Claude Code) or
  `$agmsg history` (Codex) inside the project.

Sources of truth (this section is only the human entry points): routing
rules and invariants live in `agents/global-instructions.md` ("Agent
collaboration"); procedures and message templates in
`agents/skills/agent-collab/`.

## OrbStack VM (Ubuntu 24.04)

Reproduces this dev environment in an OrbStack Linux VM via cloud-init.

```bash
orb create --isolated --forward-ssh-agent -c cloud-init/ubuntu.yaml ubuntu:24.04 dev
orb shell dev   # default user inherits from the macOS host
```

What it installs: zsh, Nix (Determinate Systems), Devbox + global packages
(`php go direnv bun git nodejs httpie cmake curl task uv`), the latest CPython
via `uv` as the global `python` / `python3`, `gh` + `gh-copilot` extension,
Docker CE (with the default user added to the `docker` group), and links
dotfiles from this repo. macOS-only items (Homebrew casks, `mas`) are skipped.

> Note: the docker group membership only takes effect after the next login —
> reconnect with `orb shell dev` or run `newgrp docker` once.

## Maintenance

```bash
# Sync dotfiles with remote (pull --rebase, commit local diff, push)
./scripts/sync

# Update brew formulae and casks
./scripts/brewUpdate

# Visualize disk usage on the desktop
./scripts/clean
```

## Optional / Manual steps

These are not run automatically. Copy & paste as needed.

### Nix vs Devbox

- **`scripts/devbox`** — packages installed via `devbox global` (default for global tools).
- **`scripts/nix-extras`** — raw `nix profile add` for things devbox can't carry well
  (unfree packages, custom flake refs). Edit the script to add packages, then run it:

  ```bash
  ./scripts/nix-extras
  ```

  Same package should never live in both — pick one path per tool.

### gh extensions

```bash
gh extension install github/gh-copilot
```
