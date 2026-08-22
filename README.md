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
6. `scripts/omp-plugins` — install the declared omp (Oh My Pi) plugin set (`omp plugin install`); the list and the skipped-as-built-in rationale live in the script

## OMP (Oh My Pi)

日常の起動方法、セッション操作、モデル運用、local memory、自動学習、定期レビュー、設定変更、トラブル対応は [`docs/omp.md`](docs/omp.md) にまとめています。

最短では、対象リポジトリで `omp`、場所を間違えたくない場合は `omp-repo <repository-path>`、非 trivial な実装は `omp-build` を使います。

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

### Agent collaboration (Herdr first, agmsg outside Herdr)

Claude Code, Codex, omp, and Copilot collaborate without manual
copy-pasting. The transport follows the execution environment:

- **Inside Herdr**: agents use `herdr-collab` for revision-pinned reviews,
  handoffs, and research sharing. It addresses peers by unique Herdr pane
  names and stores each flow under `.agent-msgs/`; it does not join or send
  through agmsg.
- **Outside Herdr**: one-shot second opinions use a headless peer CLI.
  Revision-pinned reviews, which need the full closure lifecycle, use
  [agmsg](https://github.com/fujibee/agmsg), a shared local SQLite inbox. Run
  `~/dotfiles/scripts/agmsg-pair` once per project (`--with-copilot` to
  include Copilot CLI); it is idempotent.

The shared review contract lives only in `herdr-collab`: a fresh,
different-model-family reviewer examines an immutable commit or snapshot;
`REVIEW-REQ → FINDINGS → APPLIED` (when needed) `→ VERIFIED → DECISION`
(for unresolved high/mid) then closes. `require-closed` accepts only
`closed-pass`, `closed-low`, or `closed-risk`; low-only unresolved findings
are reported, while unresolved high/mid need a user DECISION. Direct message
transport is not itself mutual review. `adversarial-verification` remains the
higher-cost two-pass mode for high-risk work.

- **Then ask in plain words**:
  - 「Codex にレビューさせて」
  - 「Codex が実装、Claude がレビューで」
  - 「この調査結果を Codex に共有して」
  - 「このタスクを Codex に渡して」
  The active agent selects Herdr or agmsg; no transport name is needed in
  the request.
- **Inspect a conversation**: inside Herdr, use
  `~/.agents/skills/herdr-collab/scripts/inbox.sh --flow <flow>`;
  outside Herdr, use `/agmsg history` (Claude Code) or `$agmsg history`
  (Codex) inside the project. Revision-pinned reviews on either transport use
  `.agent-msgs/<flow>` as the ledger and must pass
  `review-flow.py require-closed --dir .agent-msgs/<flow>`.

The split is enforced mechanically, not just by documentation. Inside a
Herdr pane (`HERDR_ENV=1`) a shell-level guard
(`agents/skills/herdr-collab/scripts/env-guard.sh`, wired through
`~/.zshenv`, `~/.bash_profile`, and `BASH_ENV` so it covers omp, Claude
Code, and Codex alike) blocks agmsg execution, `scripts/agmsg-pair` refuses
to run, and a Claude Code PreToolUse hook additionally denies agmsg
commands and loading the `agent-collab`/`agmsg` skills. In the other
direction the herdr-collab scripts exit unless `HERDR_ENV=1`. Deliberate
agmsg maintenance from a Herdr pane needs `HERDR_AGMSG_ALLOW=1`.

Sources of truth (this section is only the human entry point): the shared
review contract, tags/templates, lifecycle, validator, and Herdr transport
live in `agents/skills/herdr-collab/`; routing lives in
`agents/global-instructions.md`; the outside-Herdr fallback transport lives
in `agents/skills/agent-collab/`.

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

# Reapply OMP plugins and managed links after `omp update`
omp-apply

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
