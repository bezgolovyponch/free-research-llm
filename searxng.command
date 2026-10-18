#!/bin/zsh
set -e
CONFIG_DIR="$HOME/.config/free-research-llm/searxng"
NAME="frl-searxng"
PORT=8888
if ! perl -e 'alarm 20; exec @ARGV' docker info >/dev/null 2>&1; then
  echo "Docker is not answering. Open Docker Desktop (or quit and reopen it), wait for 'Engine running', then run this again."
  exit 1
fi
mkdir -p "$CONFIG_DIR"
cat > "$CONFIG_DIR/settings.yml" <<'YAML'
use_default_settings: true
server:
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
YAML
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run --name "$NAME" -d --restart unless-stopped \
  -p "127.0.0.1:$PORT:8080" \
  -v "$CONFIG_DIR:/etc/searxng/" \
  -e "SEARXNG_SECRET=$(openssl rand -hex 32)" \
  docker.io/searxng/searxng:latest >/dev/null
echo "Waiting for SearXNG to start..."
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/search?q=test&format=json" >/dev/null 2>&1; then
    echo "SearXNG is running at http://127.0.0.1:$PORT (unlimited, no key)."
    security add-generic-password -U -s free-research-llm -a SEARXNG_URL -w "http://127.0.0.1:$PORT"
    echo "Saved SEARXNG_URL in the Keychain. Restart the app (npm start) to use it."
    exit 0
  fi
  sleep 2
done
echo "SearXNG did not answer yet. Check: docker logs $NAME"
exit 1
