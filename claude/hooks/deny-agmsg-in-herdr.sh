#!/bin/bash
# PreToolUse hook (Bash|Skill matcher): inside a Herdr pane (HERDR_ENV=1),
# Herdr flows must run on herdr-collab only — deny agmsg script invocations
# and loading the agent-collab / agmsg skills (see Agent collaboration in
# agents/global-instructions.md). Outside Herdr everything passes.
#
# Layering: the CLI-agnostic enforcement is the shell-level env guard
# (agents/skills/herdr-collab/scripts/env-guard.sh), which covers omp /
# claude / codex alike. This hook is the Claude Code reinforcement on top:
# it denies BEFORE execution with an agent-readable reason, and it blocks
# Skill loads (agent-collab / agmsg), which no shell guard can see. The
# reverse direction — herdr-collab outside Herdr — is guarded inside the
# herdr-collab scripts themselves (they exit unless HERDR_ENV=1).
#
# Bash matching is path-anchored (home/absolute path to agmsg scripts, or
# the scripts/agmsg-pair form) so a commit message or prose merely
# mentioning agmsg is not denied. Reading agmsg files stays possible via
# the Read tool, which this hook does not match.
set -euo pipefail

[ "${HERDR_ENV:-}" = 1 ] || exit 0

input=$(cat)
tool=$(jq -r '.tool_name // empty' <<<"$input")

deny() {
  jq -cn --arg reason "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

case "$tool" in
  Bash)
    cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
    # shellcheck disable=SC2016 # literal regex: \$HOME matches the text "$HOME"
    agmsg_path='(~|/|\$HOME|\$\{HOME\})[^[:space:]]*agmsg(/scripts/[^[:space:]]+|-pair)'
    rel_pair='(^|[[:space:];&|(])(bash[[:space:]]+|sh[[:space:]]+)?(\.{0,2}/)?scripts/agmsg-pair'
    if grep -Eq "$agmsg_path" <<<"$cmd" || grep -Eq "$rel_pair" <<<"$cmd"; then
      deny "This session runs inside Herdr (HERDR_ENV=1): collaboration here goes through herdr-collab, never agmsg. Use ~/.agents/skills/herdr-collab/scripts/ (spawn.sh / send.sh / inbox.sh / despawn.sh) instead. To only read an agmsg file, use the Read tool. If the user explicitly asked for agmsg maintenance, tell them to run it from a non-Herdr shell."
    fi
    ;;
  Skill)
    skill=$(jq -r '.tool_input.skill // empty' <<<"$input")
    case "$skill" in
      agent-collab|agmsg)
        deny "This session runs inside Herdr (HERDR_ENV=1): do not load the ${skill} skill here. herdr-collab is the only collaboration skill inside Herdr — load it instead (it owns the invariants, tags/templates, and the herdr transport)."
        ;;
    esac
    ;;
esac

exit 0
