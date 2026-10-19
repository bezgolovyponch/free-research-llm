#!/bin/zsh
cd "${0:A:h}" || exit 1
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" >/dev/null 2>&1
exec node src/frl.mjs searxng "$@"
