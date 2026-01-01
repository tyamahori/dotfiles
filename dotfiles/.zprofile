eval "$(/opt/homebrew/bin/brew shellenv)"
eval "$(devbox global shellenv)"
eval "$(direnv hook zsh)"


typeset -U path PATH
path=(
        $HOME/.composer/vendor/bin
        $HOME/.go-tools/bin
        $HOME/.local/bin
        $HOME/.orbstack/bin
        $HOME/.local/share/devbox/global/default/.devbox/nix/profile/default/bin
        $HOME/.local/share/devbox/global/default/.devbox/virtenv/runx/bin
        $HOME/.bun/bin
        /opt/homebrew/bin(N-/)
        $path
)