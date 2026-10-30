# Sourced by every zsh (interactive, `zsh -c`, scripts) — keep this minimal.

# Kiro's qterm wrapper would become the pane's foreground process as
# "zsh (kiro-cli-term)", and `herdr agent start` then rejects the pane with
# agent_pane_busy. Must run before the Kiro pre block in .zprofile.
[[ $TERM_PROGRAM == herdr ]] && export Q_TERM_DISABLED=1
