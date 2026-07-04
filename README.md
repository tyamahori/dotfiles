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
2. `scripts/link` — symlink dotfiles into `$HOME`, global gitignore into `$HOME/.config/git/ignore`, and shared agent instructions (see below) into each LLM CLI's config
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
