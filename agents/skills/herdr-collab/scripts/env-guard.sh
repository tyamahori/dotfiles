#!/bin/sh
# herdr-collab env guard — SOURCED, never executed. Wired in three places so
# it reaches every agent CLI (claude / omp / codex / copilot), not one brand's
# hook system: ~/.zshenv (zsh: `zsh -c`, interactive, scripts),
# ~/.bash_profile (login bash: `bash -lc`), and exported as BASH_ENV
# (non-interactive bash: `bash -c`, #!/bin/bash shebang scripts).
#
# Inside a Herdr pane (HERDR_ENV=1) collaboration runs on herdr-collab only;
# agmsg must not be touched (a herdr-only flow once left a stray agmsg team
# registration). This guard enforces that structurally: it inspects the `-c`
# command string (BASH_EXECUTION_STRING / ZSH_EXECUTION_STRING) and the
# directly-executed script path ($0), and kills the shell before the command
# runs on a match. Matching is path-anchored so prose or a commit message
# that merely mentions agmsg is not blocked.
#
# Escape hatch for deliberate agmsg maintenance from a Herdr pane:
# HERDR_AGMSG_ALLOW=1 (or run from a non-Herdr shell).

if [ "${HERDR_ENV-}" = 1 ] && [ "${HERDR_AGMSG_ALLOW-}" != 1 ]; then
  _hcg_hit=""
  case "${0-}" in
    */agmsg/scripts/*|*/agmsg-pair) _hcg_hit=1 ;;
  esac
  # shellcheck disable=SC3028 # set by the bash/zsh that sources this file
  _hcg_str="${BASH_EXECUTION_STRING-}${ZSH_EXECUTION_STRING-}"
  if [ -z "$_hcg_hit" ] && [ -n "$_hcg_str" ]; then
    # shellcheck disable=SC2016 # literal regex: \$HOME matches the text "$HOME"
    if printf '%s' "$_hcg_str" | grep -Eq \
      '(~|/|\$HOME|\$\{HOME\})[^[:space:]]*agmsg(/scripts/[^[:space:]]+|-pair)|(^|[[:space:];&|(])(bash[[:space:]]+|sh[[:space:]]+)?(\.{0,2}/)?scripts/agmsg-pair'; then
      _hcg_hit=1
    fi
  fi
  if [ -n "$_hcg_hit" ]; then
    echo "herdr-collab guard: agmsg is blocked inside Herdr (HERDR_ENV=1)." >&2
    echo "Herdr flows use herdr-collab only:" >&2
    echo "  ~/.agents/skills/herdr-collab/scripts/{spawn,send,inbox,despawn}.sh" >&2
    echo "Reading a file? Use your file-read tool, not a shell command." >&2
    echo "Deliberate agmsg maintenance: run it outside Herdr, or set HERDR_AGMSG_ALLOW=1." >&2
    unset _hcg_hit _hcg_str
    exit 2
  fi
  unset _hcg_hit _hcg_str
fi
