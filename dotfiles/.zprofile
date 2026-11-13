# Kiro CLI pre block. Keep at the top of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.pre.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.pre.zsh"






[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
# devbox global shellenv は 1 回 ~140ms かかるので、親から環境を継いだ login shell
# （DEVBOX_PACKAGES_DIR あり）では省く。.zshrc と同じ条件。パッケージ追加で増えた
# 環境変数を継いだシェルへ反映するには refresh-global か新しいターミナルを使う。
# refresh-global は shellenv が定義する alias なので、省いたシェルにはここで用意する。
if [[ -z "$CODEX_SHELL" && -z "$CODEX_SANDBOX" ]]; then
  if [[ -z "$DEVBOX_PACKAGES_DIR" ]]; then
    command -v devbox >/dev/null 2>&1 && eval "$(devbox global shellenv)"
  else
    alias refresh-global='eval "$(devbox global shellenv)" && hash -r'
  fi
fi

# OrbStack をアンインストールしても ~/.orbstack/bin は壊れた symlink のまま残り、
# Docker Desktop の docker（/usr/local/bin）より先に解決されてしまう。
# orb の実体がある（-: symlink をたどる、*: 実行可能）ときだけ足す。
typeset -U path PATH
path=(
        $HOME/.npm-global/bin
        $HOME/go/bin
        $HOME/.local/bin
        $HOME/.orbstack/bin/orb(N-*:h)
        $HOME/.local/share/devbox/global/default/.devbox/nix/profile/default/bin
        $HOME/.local/share/devbox/global/default/.devbox/virtenv/runx/bin
        $HOME/.bun/bin
        $HOME/.dotnet/tools
        /opt/homebrew/bin(N-/)
        $path
)


# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
[[ -x ~/.orbstack/bin/orb ]] && source ~/.orbstack/shell/init.zsh 2>/dev/null || :




# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zprofile.post.zsh"
