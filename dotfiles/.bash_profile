# Login bash reads this instead of BASH_ENV, so the Herdr collaboration guard
# is sourced here too — this is the path `bash -lc` (Codex et al.) takes.
# See agents/skills/herdr-collab/scripts/env-guard.sh for what it enforces.
if [ "${HERDR_ENV-}" = 1 ] && [ -r "$HOME/.agents/skills/herdr-collab/scripts/env-guard.sh" ]; then
  export BASH_ENV="$HOME/.agents/skills/herdr-collab/scripts/env-guard.sh"
  . "$BASH_ENV"
fi

# Keep interactive login shells consistent with interactive non-login ones.
case $- in *i*) [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" ;; esac
