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

echo ""
echo "Free Research LLM - key setup"
echo "Keys are stored in your macOS Keychain (service: $SERVICE), not in any file."
echo "For each line: open the link, create a key, paste it here (input is hidden), press Enter."
echo "Press Enter on an empty line to skip. Type - to delete a stored key."
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
    security add-generic-password -U -s "$SERVICE" -a "$NAME" -w "$VALUE" && echo "        saved"
  fi
  VALUE=""
done
echo ""
echo "Done. Start the app with ./start.command or: npm start"
read -r "?Press Enter to close"
