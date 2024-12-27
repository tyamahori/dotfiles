eval "$(devbox global shellenv)"
eval "$(direnv hook zsh)"

# go
export GOPATH=$(go env GOPATH)
export PATH=$PATH:$GOPATH/bin

# composer
export PATH="$PATH:$HOME/.composer/vendor/bin"