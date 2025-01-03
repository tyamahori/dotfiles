eval "$(devbox global shellenv)"
eval "$(direnv hook zsh)"

export GOPATH=$HOME/.go-tools

typeset -U path PATH
path=(
        $HOME/.composer/vendor/bin
        $GOPATH/bin
        $HOME/.nix-profile/bin
        $HOME/.local/bin
        $HOME/.orbstack/bin
        $HOME/.local/share/devbox/global/default/.devbox/nix/profile/default/bin
        $HOME/.local/share/devbox/global/default/.devbox/virtenv/runx/bin
        /opt/homebrew/bin(N-/)
        /usr/local/bin(N-/)
        $path
)
if (( $+commands[sw_vers] )) && (( $+commands[arch] )); then
        [[ -x /usr/local/bin/brew ]] && alias brew="arch -arch x86_64 /usr/local/bin/brew"
        alias x64='exec arch -x86_64 /bin/zsh'
        alias a64='exec arch -arm64e /bin/zsh'
        switch-arch() {
                if  [[ "$(uname -m)" == arm64 ]]; then
                        arch=x86_64
                elif [[ "$(uname -m)" == x86_64 ]]; then
                        arch=arm64e
                fi
                exec arch -arch $arch /bin/zsh
        }
fi
setopt magic_equal_subst