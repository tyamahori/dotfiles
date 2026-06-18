
# Kiro CLI pre block. Keep at the top of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.pre.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.pre.zsh"


[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
command -v devbox >/dev/null 2>&1 && eval "$(devbox global shellenv)"
command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"


typeset -U path PATH
path=(
        $HOME/.npm-global/bin
        $HOME/.composer/vendor/bin
        $HOME/.go-tools/bin
        $HOME/go/bin
        $HOME/.local/bin
        $HOME/.orbstack/bin
        $HOME/.local/share/devbox/global/default/.devbox/nix/profile/default/bin
        $HOME/.local/share/devbox/global/default/.devbox/virtenv/runx/bin
        $HOME/.bun/bin
        /opt/homebrew/bin(N-/)
        $path
)

# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.post.zsh"

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :