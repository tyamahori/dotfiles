# Keep interactive login shells consistent with interactive non-login ones.
case $- in *i*) [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc" ;; esac
