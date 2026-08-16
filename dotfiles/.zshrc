
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
# omp: ~ で起動しても temp ディレクトリへ自動退避せずカレントで開く。
# Fable 専用7日枠(anthropic:7d:fable)または5時間枠(anthropic:5h)の消費が
# 90%に達したら、default を Codex に振り替えて起動する。omp 本体の
# reserve fallback は Fable 枠を100%到達まで判定に使わないため、その手前を
# ここで塞ぐ。判定はキャッシュ済み usage(約0.7秒)を読むだけ。
omp() {
  local threshold=0.90 target='openai-codex/gpt-5.6-terra' quota quota_id quota_used quota_label
  quota=$(command omp usage --json --provider anthropic 2>/dev/null |
    jq -r --argjson threshold "$threshold" '
      [.. | objects
       | select(.id? == "anthropic:7d:fable" or .id? == "anthropic:5h")
       | {id, usedFraction: .amount.usedFraction}]
      | map(select(.usedFraction >= $threshold))
      | max_by(.usedFraction)
      | if . == null then empty else "\(.id)\t\(.usedFraction)" end')
  if [[ -n "$quota" ]]; then
    quota_id=${quota%%$'\t'*}
    quota_used=${quota#*$'\t'}
    [[ "$quota_id" == "anthropic:5h" ]] && quota_label='5時間枠' || quota_label='Fable 7日枠'
    print -u2 "omp: ${quota_label} ${quota_used} 消費済み(閾値 ${threshold}) → ${target} で起動"
    command omp --allow-home --model "$target" "$@"
  else
    command omp --allow-home "$@"
  fi
}
# omp: マシンローカルのモデル設定オーバーレイ。ローカル LLM(ollama 等)を
# 入れたマシンだけ ~/.omp/agent/config.local.yml を置くと、共有 config.yml に
# deep-merge される(modelRoles の部分上書きが可能)。ファイルが無いのに
# PI_CONFIG_FILES を設定すると omp が起動エラーになるため、存在ガード必須。
# このファイルは dotfiles 管理外(マシン固有なので symlink しない)。
[[ -f "$HOME/.omp/agent/config.local.yml" ]] && export PI_CONFIG_FILES="$HOME/.omp/agent/config.local.yml"
alias ll='ls -la'
alias reload='source ~/.zshrc'

# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh"
# JetBrains Context CLI
export PATH="$PATH:${HOME}/.jbcontext/bin"

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<
