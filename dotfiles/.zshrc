
# Kiro CLI pre block. Keep at the top of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.pre.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.pre.zsh"


# omp の zsh 補完。毎起動の eval は omp の起動コスト（~1秒）が乗るため、
# バイナリが更新されたときだけ再生成してキャッシュを fpath に載せる。
# 補完本体は実行時に `omp __complete` を呼ぶ薄いラッパなので陳腐化しない。
if command -v omp >/dev/null 2>&1; then
  _omp_comp_dir="$HOME/.zsh/completions"
  if [[ ! -f "$_omp_comp_dir/_omp" || "${$(command -v omp):A}" -nt "$_omp_comp_dir/_omp" ]]; then
    mkdir -p "$_omp_comp_dir"
    command omp completions zsh > "$_omp_comp_dir/_omp" 2>/dev/null
  fi
  FPATH="$_omp_comp_dir:$FPATH"
  unset _omp_comp_dir
fi

if type brew &>/dev/null; then
  FPATH=$(brew --prefix)/share/zsh-completions:$FPATH
  [ -r "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ] && \
    source "$(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh"

  autoload -Uz compinit
  compinit
fi

if [[ "$(uname)" == "Linux" ]]; then
  PROMPT='%n@%m %~ %# '
fi

export HOMEBREW_NO_ASK=1
alias brewup='sudo -v && brew update && brew upgrade --greedy && brew cleanup --prune=all'
# omp: ~ で起動しても temp ディレクトリへ自動退避せずカレントで開く
alias omp='omp --allow-home'

# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh"
# JetBrains Context CLI
export PATH="$PATH:${HOME}/.jbcontext/bin"
