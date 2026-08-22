# Sourced by every zsh (interactive, `zsh -c`, scripts) — keep this minimal.
#
# Herdr collaboration guard: inside a Herdr pane (HERDR_ENV=1) agmsg is
# blocked structurally — herdr flows run on herdr-collab only. Sourcing here
# covers zsh-driven agent CLIs (claude, omp); exporting BASH_ENV makes
# non-interactive bash (`bash -c`, #!/bin/bash scripts) source the same guard.
if [ "${HERDR_ENV-}" = 1 ] && [ -r "$HOME/.agents/skills/herdr-collab/scripts/env-guard.sh" ]; then
  export BASH_ENV="$HOME/.agents/skills/herdr-collab/scripts/env-guard.sh"
  . "$BASH_ENV"
fi
