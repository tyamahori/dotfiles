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

### Extra casks (uncomment in `.Brewfile` if desired)

```bash
brew install --cask codex-app
brew install --cask obsidian
```

### gh extensions

```bash
gh extension install github/gh-copilot
```
