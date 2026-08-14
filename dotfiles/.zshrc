
# Kiro CLI pre block. Keep at the top of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.pre.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.pre.zsh"


# 履歴。既定は macOS /etc/zshrc の SAVEHIST=1000 で、実際に溢れて古い
# 履歴が消えていた。zsh-autosuggestions の提案品質も履歴量に依存する。
# SHARE_HISTORY は herdr の複数ペイン間で履歴を即時共有する。
HISTSIZE=100000
SAVEHIST=100000
setopt EXTENDED_HISTORY      # 実行時刻・所要時間も記録
setopt SHARE_HISTORY         # セッション/ペイン間で即時共有
setopt HIST_IGNORE_ALL_DUPS  # 重複は最新だけ残す
setopt HIST_IGNORE_SPACE     # 先頭スペースの行は残さない（秘匿用）
setopt HIST_REDUCE_BLANKS

# よく行くリポジトリへどこからでも `cd funabashidev/bot` などで移動。
# AUTO_CD はディレクトリ名だけの入力を cd 扱いにする。
setopt AUTO_CD
cdpath=("$HOME" "$HOME/project")

# CLI 補完のキャッシュ。毎起動の eval はツールの起動コスト（omp は ~1秒）が
# 乗るため、バイナリが更新されたときだけ再生成して fpath に載せる。
# omp の補完本体は実行時に `omp __complete` を呼ぶ薄いラッパなので陳腐化しない。
_comp_cache_dir="$HOME/.zsh/completions"
_cache_completion() {
  local cmd=$1; shift
  command -v "$cmd" >/dev/null 2>&1 || return 0
  local out="$_comp_cache_dir/_$cmd"
  if [[ ! -f "$out" || "${$(command -v "$cmd"):A}" -nt "$out" ]]; then
    mkdir -p "$_comp_cache_dir"
    command "$@" > "$out" 2>/dev/null || rm -f "$out"
  fi
}
_cache_completion omp omp completions zsh
_cache_completion herdr herdr completion zsh
FPATH="$_comp_cache_dir:$FPATH"
unset _comp_cache_dir
unfunction _cache_completion

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
alias ll='ls -la'
alias reload='source ~/.zshrc'

# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh"
# JetBrains Context CLI
export PATH="$PATH:${HOME}/.jbcontext/bin"
