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
2. `scripts/link` — symlink dotfiles into `$HOME` and global gitignore into `$HOME/.config/git/ignore`
3. `scripts/apps` — `brew bundle --global` from `~/.Brewfile`
4. `scripts/devbox` — install global devbox packages (php, go, direnv, bun, git, nodejs, mas, httpie, cmake, curl, task)

## OrbStack VM (Ubuntu 24.04)

Reproduces this dev environment in an OrbStack Linux VM via cloud-init.

```bash
orb create --isolated --forward-ssh-agent -c cloud-init/ubuntu.yaml ubuntu:24.04 dev
orb shell dev   # default user inherits from the macOS host
```

What it installs: zsh, Nix (Determinate Systems), Devbox + global packages
(`php go direnv bun git nodejs httpie cmake curl task`), `gh` + `gh-copilot`
extension, Docker CE (with the default user added to the `docker` group), and
links dotfiles from this repo. macOS-only items (Homebrew casks, `mas`) are
skipped.

> Note: the docker group membership only takes effect after the next login —
> reconnect with `orb shell dev` or run `newgrp docker` once.

## Maintenance

```bash
# Update brew formulae and casks
./scripts/brewUpdate

# Visualize disk usage on the desktop
./scripts/clean
```

## Optional / Manual steps

These are not run automatically. Copy & paste as needed.

### Install unfree Nix packages

```bash
NIXPKGS_ALLOW_UNFREE=1 nix profile add <package> --impure
NIXPKGS_ALLOW_UNFREE=1 nix profile upgrade --all --impure
```

### gh extensions

```bash
gh extension install github/gh-copilot
```
