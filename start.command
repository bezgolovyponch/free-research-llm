#!/bin/zsh
cd "$(dirname "$0")" || exit 1
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required: https://nodejs.org (LTS installer), then double-click start.command again."
  read -r "?Press Enter to close"
  exit 1
fi
PORT="${PORT:-4600}"
(sleep 1.5 && open "http://127.0.0.1:${PORT}") &
exec node src/server.mjs
