eval "$(devbox global shellenv)"
eval "$(direnv hook zsh)"

# composer
export COMPOSERPATH=$PWD/.composer/vendor/bin
export GOPATH=$PWD/.go-tools
export PATH=$GOPATH/bin:COMPOSERPATH:$PATH
typeset -U PATH