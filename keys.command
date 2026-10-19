#!/bin/zsh
cd "${0:A:h}" || exit 1
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" >/dev/null 2>&1
case "$1" in
  check) exec node src/frl.mjs keys check ;;
  search) exec node src/frl.mjs keys setup search ;;
  *) exec node src/frl.mjs keys setup ;;
esac
