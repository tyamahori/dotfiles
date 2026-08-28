# devbox
eval "$(devbox global shellenv)"

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

# プロンプト。左に pwd + git ブランチ、右に Claude/Codex の subscription
# 使用率を常時表示する。使用率の源泉は omp が ~/.omp/agent/agent.db に記録
# する usage snapshot（anthropic-usage-guard と同じ）。Claude は
# F=Fable(7d) / A=全モデル(7d) / S=セッション(5h) の3枠、Codex は primary
# 枠を表示する。omp を暫く起動しないと snapshot が更新されないため、
# 1時間より古い値は薄く `*` 付きで示す。sqlite3 の読みは数十ms
# だが毎プロンプトでは走らせず、60秒 TTL のキャッシュを挟む。
setopt PROMPT_SUBST
autoload -Uz vcs_info add-zsh-hook
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' formats ' %F{cyan}(%b)%f'
zstyle ':vcs_info:git:*' actionformats ' %F{cyan}(%b|%a)%f'

_agent_usage_cache="${XDG_CACHE_HOME:-$HOME/.cache}/agent-usage-prompt"
_agent_usage_refresh() {
  local db="$HOME/.omp/agent/agent.db"
  local -a claude parts
  local key pct age tok
  if [[ -r $db ]] && command -v sqlite3 >/dev/null 2>&1; then
    while read -r key pct age; do
      if (( age > 60 )); then
        tok="%F{242}${pct}%%*%f"
      elif (( pct >= 80 )); then
        tok="%F{red}${pct}%%%f"
      elif (( pct >= 50 )); then
        tok="%F{yellow}${pct}%%%f"
      else
        tok="${pct}%%"
      fi
      case $key in
        F|A|S) claude+=("${key}${tok}") ;;
        codex) parts+=("Codex ${tok}") ;;
      esac
    done < <(sqlite3 -separator ' ' "file:$db?mode=ro" "
      SELECT CASE lower(u.limit_id)
               WHEN 'anthropic:7d:fable' THEN 'F'
               WHEN 'anthropic:7d' THEN 'A'
               WHEN 'anthropic:5h' THEN 'S'
               ELSE 'codex' END AS key,
             CAST(MAX(u.used_fraction)*100+0.5 AS INTEGER),
             CAST((strftime('%s','now')*1000 - MAX(u.recorded_at))/60000 AS INTEGER)
      FROM usage_history u
      WHERE u.resets_at > strftime('%s','now')*1000
        AND u.recorded_at = (
          SELECT MAX(x.recorded_at)
          FROM usage_history x
          WHERE lower(x.provider)=lower(u.provider)
            AND lower(x.limit_id)=lower(u.limit_id)
        )
        AND lower(u.limit_id) IN
            ('anthropic:7d:fable','anthropic:7d','anthropic:5h','openai-codex:primary')
      GROUP BY key
      ORDER BY CASE key WHEN 'F' THEN 0 WHEN 'A' THEN 1 WHEN 'S' THEN 2 ELSE 3 END;" 2>/dev/null)
    (( $#claude )) && parts=("Claude ${(j:/:)claude}" $parts)
  fi
  mkdir -p "${_agent_usage_cache:h}"
  print -r -- "${(j: :)parts}" > "$_agent_usage_cache"
}
_agent_usage_precmd() {
  local -a fresh
  fresh=("$_agent_usage_cache"(Nmm-1))
  (( $#fresh )) || _agent_usage_refresh
  _agent_usage_rprompt="$(<"$_agent_usage_cache")" 2>/dev/null
  vcs_info
}
add-zsh-hook precmd _agent_usage_precmd

# pwd が深いと入力位置が右へ流れるので、pwd+ブランチは1行目、入力は2行目。
# RPROMPT は入力行(2行目)の右に出る。
PROMPT='%F{blue}%~%f${vcs_info_msg_0_}
%# '
[[ "$(uname)" == "Linux" ]] && PROMPT='%n@%m '$PROMPT
RPROMPT='${_agent_usage_rprompt}'

export HOMEBREW_NO_ASK=1
alias brewup='sudo -v && brew update && brew upgrade --greedy && brew cleanup --prune=all'
# omp: ~ で起動しても temp ディレクトリへ自動退避せずカレントで開く。
# quota退避はglobal extensionのanthropic-usage-guardが全起動経路で処理する。
omp() {
  command omp --allow-home "$@"
}
# omp-repo: 指定した repository root から起動し、local memory を repository 単位に分離する。
omp-repo() {
  if (( $# == 0 )); then
    print -u2 'usage: omp-repo <repository-path> [omp-args...]'
    return 2
  fi
  local target="$1"
  shift
  if [[ ! -d "$target" ]]; then
    print -u2 "omp-repo: directory not found: $target"
    return 2
  fi
  local repo_root
  repo_root="$(command git -C "$target" rev-parse --show-toplevel 2>/dev/null)" || {
    print -u2 "omp-repo: not a git repository: $target"
    return 2
  }
  (
    builtin cd "$repo_root" || return 1
    command omp "$@"
  )
}
# omp-build: 非trivial実装を計画後にtask roleへ切り替えて実行する。
omp-build() {
  command omp --allow-home --prewalk --prewalk-into @task "$@"
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
