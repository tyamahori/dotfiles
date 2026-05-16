[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
command -v devbox >/dev/null 2>&1 && eval "$(devbox global shellenv)"
command -v direnv >/dev/null 2>&1 && eval "$(direnv hook zsh)"


typeset -U path PATH
path=(
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