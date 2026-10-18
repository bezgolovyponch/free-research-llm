#!/bin/zsh
SERVICE="free-research-llm"
KEYS=(
  "GEMINI_API_KEY|Google Gemini  (best main model)|https://aistudio.google.com/apikey"
  "GROQ_API_KEY|Groq  (fastest)|https://console.groq.com/keys"
  "MISTRAL_API_KEY|Mistral  (biggest free volume; phone verification)|https://console.mistral.ai/api-keys"
  "CEREBRAS_API_KEY|Cerebras  (fast, 5 requests/min)|https://cloud.cerebras.ai"
  "NVIDIA_API_KEY|NVIDIA build  (many models, ~40 requests/min)|https://build.nvidia.com"
  "OPENROUTER_API_KEY|OpenRouter  (free models, 50/day)|https://openrouter.ai/settings/keys"
  "SAMBANOVA_API_KEY|SambaNova  (small daily quota)|https://cloud.sambanova.ai/apis"
  "CLOUDFLARE_ACCOUNT_ID|Cloudflare ACCOUNT ID  (dashboard right sidebar)|https://dash.cloudflare.com"
  "CLOUDFLARE_API_TOKEN|Cloudflare API token  (Workers AI permission)|https://dash.cloudflare.com/profile/api-tokens"
  "COHERE_API_KEY|Cohere trial  (1,000 calls/month)|https://dashboard.cohere.com/api-keys"
  "PUTER_AUTH_TOKEN|Puter auth token  (uses your Puter allowance)|https://puter.com/dashboard#account"
  "LANGSEARCH_API_KEY|LangSearch web search  (free, no monthly cap)|https://langsearch.com/api-keys"
  "TAVILY_API_KEY|Tavily web search  (1,000/month)|https://app.tavily.com"
  "EXA_API_KEY|Exa web search  (\$10/month credit)|https://dashboard.exa.ai/api-keys"
  "LINKUP_API_KEY|Linkup web search  (free monthly credit)|https://app.linkup.so"
  "JINA_API_KEY|Jina search + page reader  (10M tokens once)|https://jina.ai/api-dashboard"
  "FIRECRAWL_API_KEY|Firecrawl web search  (free monthly credits)|https://www.firecrawl.dev/app/api-keys"
  "SERPER_API_KEY|Serper Google search  (2,500 once)|https://serper.dev/api-key"
  "SEARXNG_URL|SearXNG address  (type http://127.0.0.1:8888 after ./searxng.command)|http://127.0.0.1:8888"
)
SEARCH_ONLY="LANGSEARCH_API_KEY TAVILY_API_KEY EXA_API_KEY LINKUP_API_KEY JINA_API_KEY FIRECRAWL_API_KEY SERPER_API_KEY SEARXNG_URL"

cd "${0:A:h}"

mask() { local v="$1"; if (( ${#v} <= 10 )); then echo "${#v} chars"; else echo "${v[1,6]}…${v[-4,-1]} (${#v} chars)"; fi; }

save_checked() {
  local NAME="$1" RAW="$2" OUT STATE CLEAN MSG ANSWER
  OUT=$(printf '%s' "$RAW" | node scripts/check-key.mjs "$NAME")
  STATE=$(sed -n 1p <<< "$OUT"); CLEAN=$(sed -n 2p <<< "$OUT"); MSG=$(sed -n 3p <<< "$OUT")
  echo "        got $(mask "$CLEAN")"
  case "$STATE" in
    ok) security add-generic-password -U -s "$SERVICE" -a "$NAME" -w "$CLEAN" && echo "        ✓ works ($MSG) — saved" ;;
    repaired) security add-generic-password -U -s "$SERVICE" -a "$NAME" -w "$CLEAN" && echo "        ✓ repaired and saved: $MSG" ;;
    unchecked) security add-generic-password -U -s "$SERVICE" -a "$NAME" -w "$CLEAN" && echo "        saved ($MSG)" ;;
    *)
      echo "        ✗ this key does not work: $MSG"
      read -r "ANSWER?        save it anyway? (y/N) "
      [[ "$ANSWER" == [yY]* ]] && security add-generic-password -U -s "$SERVICE" -a "$NAME" -w "$CLEAN" && echo "        saved"
      return 1 ;;
  esac
}

reload_app() {
  if curl -s -m 5 -X POST "http://127.0.0.1:${PORT:-4600}/api/keys/reload" >/dev/null 2>&1; then
    echo "The running app reloaded the keys (no restart needed)."
  else
    echo "Start the app with ./start.command or: npm start"
  fi
}

if [[ "$1" == "check" ]]; then
  echo ""
  echo "Checking every saved key (each one is tested against its provider; a key cut off while pasting is repaired):"
  for entry in "${KEYS[@]}"; do
    NAME="${entry%%|*}"
    VALUE=$(security find-generic-password -s "$SERVICE" -a "$NAME" -w 2>/dev/null) || continue
    echo "$NAME"
    save_checked "$NAME" "$VALUE" < /dev/null
    VALUE=""
  done
  echo ""
  reload_app
  exit 0
fi

echo ""
echo "Free Research LLM - key setup"
echo "Keys are stored in your macOS Keychain (service: $SERVICE), not in any file."
echo "For each line: open the link, create a key, paste it here (input is hidden), press Enter."
echo "Each key is tested right away. Press Enter on an empty line to skip. Type - to delete a stored key."
echo ""
for entry in "${KEYS[@]}"; do
  NAME="${entry%%|*}"; REST="${entry#*|}"; LABEL="${REST%%|*}"; URL="${REST#*|}"
  if [[ "$1" == "search" && " $SEARCH_ONLY " != *" $NAME "* ]]; then continue; fi
  if security find-generic-password -s "$SERVICE" -a "$NAME" >/dev/null 2>&1; then STATE="[saved]"; else STATE="[empty]"; fi
  echo "$STATE $LABEL"
  echo "        $URL"
  read -rs "VALUE?        paste $NAME: "
  echo ""
  if [[ "$VALUE" == "-" ]]; then
    security delete-generic-password -s "$SERVICE" -a "$NAME" >/dev/null 2>&1 && echo "        deleted"
  elif [[ -n "$VALUE" ]]; then
    save_checked "$NAME" "$VALUE"
  fi
  VALUE=""
done
echo ""
reload_app
read -r "?Press Enter to close"
