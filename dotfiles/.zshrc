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

# 補完。fpath は前にある方が優先。devbox の nix profile は
# `devbox global shellenv` が PATH にしか載せないので、そこにある
# gh/jj/uv/pnpm/bun/aws/gcloud/task の補完は明示しないと一切効かない。
#
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
_cache_completion devbox devbox completion zsh
unfunction _cache_completion

typeset -U fpath FPATH
fpath=(
  "$_comp_cache_dir"
  "$HOME"/.grok/completions/zsh(N-/)
  "$HOME"/.local/share/devbox/global/default/.devbox/nix/profile/default/share/zsh/site-functions(N-/)
  "${HOMEBREW_PREFIX:-/opt/homebrew}"/share/zsh-completions(N-/)
  "${HOMEBREW_PREFIX:-/opt/homebrew}"/share/zsh/site-functions(N-/)
  $fpath
)
unset _comp_cache_dir

# compinit は dump が古いか fpath のファイル数が変わると再生成（~600ms）、
# それ以外でも compaudit 込みで ~60ms かかる。dump が24時間以内なら -C で
# 読み込みだけ（~20ms）。新しい補完を即反映したいときは `rm ~/.zcompdump; reload`。
autoload -Uz compinit
if [[ -n ~/.zcompdump(#qN.mh-24) ]]; then compinit -C; else compinit; fi
# clap 生成の _jj は初回呼び出しで本体関数を定義して compdef し直すだけなので、
# そのままだと各シェルで最初の TAB が空振りする。先に一度呼んで定義させる。
(( $+functions[_jj] )) && _jj

zstyle ':completion:*' menu select                                  # 候補を矢印キーで選ぶ
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=*'  # 大小無視、区切り文字の途中一致
zstyle ':completion:*' group-name ''                                # 種別ごとに見出しを付けて分ける
zstyle ':completion:*:descriptions' format '%F{yellow}%d%f'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*' use-cache yes                                # brew/gh など重い候補列挙を保存
zstyle ':completion:*' cache-path "$HOME/.zsh/cache"
setopt COMPLETE_IN_WORD                                             # カーソルが単語の途中でも補完

[ -r "${HOMEBREW_PREFIX:-/opt/homebrew}/share/zsh-autosuggestions/zsh-autosuggestions.zsh" ] && \
  source "${HOMEBREW_PREFIX:-/opt/homebrew}/share/zsh-autosuggestions/zsh-autosuggestions.zsh"

# プロンプト。pwd + git ブランチ、Claude/Codex の subscription 使用率、
# 入力欄を3行に分けて常時表示する。使用率の源泉は omp が記録
# する usage snapshot（anthropic-usage-guard と同じ）。Claude は
# F=Fable(7d) / A=全モデル(7d) / S=セッション(5h) の3枠、Codex は primary
# 枠を表示する。provider名はClaudeがオレンジ、Codexが青。使用率は80%以上を
# 赤、50%以上を黄で示し、各枠のリセットまでの残り時間を併記する。
# snapshot が1時間より古い場合は `*`。値はシェル内で60秒キャッシュする。
setopt PROMPT_SUBST
autoload -Uz vcs_info add-zsh-hook
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:git:*' formats ' %F{cyan}(%b)%f'
zstyle ':vcs_info:git:*' actionformats ' %F{cyan}(%b|%a)%f'

typeset -gi _agent_usage_refreshed_at=-60
_agent_usage_refresh() {
  local db="$HOME/.omp/agent/agent.db"
  local -a claude parts
  local key pct age reset_mins tok reset
  if [[ -r $db ]] && command -v sqlite3 >/dev/null 2>&1; then
    while read -r key pct age reset_mins; do
      tok="${pct}%%"
      (( age > 60 )) && tok+="*"
      if (( reset_mins < 120 )); then
        reset="${reset_mins}m"
      elif (( reset_mins < 2880 )); then
        reset="$(( (reset_mins + 30) / 60 ))h"
      else
        reset="$(( (reset_mins + 720) / 1440 ))d"
      fi
      if (( pct >= 80 )); then
        tok="%F{red}${tok}%f"
      elif (( pct >= 50 )); then
        tok="%F{yellow}${tok}%f"
      fi
      tok+="%F{242}(${reset})%f"
      case $key in
        F|A|S) claude+=("${key}${tok}") ;;
        codex) parts+=("%F{blue}Codex%f Usage: ${tok}") ;;
      esac
    done < <(sqlite3 -separator ' ' "file:$db?mode=ro" "
      SELECT CASE lower(u.limit_id)
               WHEN 'anthropic:7d:fable' THEN 'F'
               WHEN 'anthropic:7d' THEN 'A'
               WHEN 'anthropic:5h' THEN 'S'
               ELSE 'codex' END AS key,
             CAST(MAX(u.used_fraction)*100+0.5 AS INTEGER),
             CAST((strftime('%s','now')*1000 - MAX(u.recorded_at))/60000 AS INTEGER),
             CAST((MAX(u.resets_at) - strftime('%s','now')*1000)/60000 AS INTEGER)
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
    (( $#claude )) && parts=("%F{208}Claude%f Usage: ${(j:_:)claude}" $parts)
  fi
  _agent_usage_prompt="${(j: / :)parts}"
}
_agent_usage_precmd() {
  if (( SECONDS - _agent_usage_refreshed_at >= 60 )); then
    _agent_usage_refresh
    _agent_usage_refreshed_at=$SECONDS
  fi
  vcs_info
}
add-zsh-hook precmd _agent_usage_precmd

# pwd+ブランチ、usage、入力をそれぞれ別の行に表示する。
PROMPT='%F{blue}%~%f${vcs_info_msg_0_}
${_agent_usage_prompt}
%# '
[[ "$(uname)" == "Linux" ]] && PROMPT='%n@%m '$PROMPT

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
# terminal-browser: デフォルトは display リフレッシュ(ProMotion=120fps) × Retina 2x で
# フレームを kitty graphics として herdr server → Ghostty に流すため、スクロール中に
# Ghostty のレンダラと herdr server が飽和してターミナル全体が重くなる
# (実測: 30fps+1x でも ghostty ~113% / herdr server ~61%)。観察・プレビュー用途には
# 30fps + 非Retina描画で十分。
export TERMINAL_BROWSER_FPS=30
export TERMINAL_BROWSER_RENDER_SCALE=1
alias ll='ls -la'
alias reload='source ~/.zshrc'

# Kiro CLI post block. Keep at the bottom of this file.
[[ -f "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh" ]] && builtin source "${HOME}/Library/Application Support/kiro-cli/shell/zshrc.post.zsh"
# JetBrains Context CLI
export PATH="$PATH:${HOME}/.jbcontext/bin"

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
# <<< grok installer <<<
