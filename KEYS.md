# KEYS — which free keys to get, where, and where to paste them

Checked against each provider's own docs on **2026-10-18**. Free tiers change often; if a number below looks wrong, the provider's page wins.

## The recommended set

| Priority | Get this | Why | Free limit (official) | Card? |
|---|---|---|---|---|
| **1 — must** | **Gemini** | best free main model: writes the issue tree and the memo | per-model RPM/RPD shown in your AI Studio dashboard | no |
| **1 — must** | **Groq** | fastest; researches most sub-questions | `gpt-oss-120b` / `gpt-oss-20b`: 30 req/min, 1,000 req/day, 8K tokens/min, 200K tokens/day | no |
| **1 — must** | **LangSearch** | free web search with full page text; carries most queries | free plan, 5 req/s for new accounts; daily token limits shown in your dashboard (no monthly cap published) | no |
| **1 — must** | **Tavily** | second search engine, full page text | 1,000 credits/month | no |
| **1 — must** | **SearXNG** (open source, on your Mac) | unlimited metasearch (Google/Bing/DDG/… results), no key | none — runs in Docker on 127.0.0.1:8888 | no |
| 2 — strongly | **Mistral** | huge free volume, good backup for both roles | 1 req/s, 500K tokens/min, 1B tokens/month per model (third-party summary of the Experiment plan) | no — **phone verification**, and your requests may be used for training |
| 2 — strongly | **Cerebras** | very fast `gpt-oss-120b`, `qwen-3.8-27b` | 5 req/min, 1M tokens/day | no |
| 2 — strongly | **NVIDIA build** | 100+ models, independent reviewer | ~40 req/min (community-reported, not an SLA); prototyping use | no |
| 3 — nice | **Exa** | semantic search, returns full page text | $10 credit/month (~1,400 searches) | no |
| 3 — nice | **Linkup** | search for agents | €5 free; $20/month top-up for sign-ups with a work email | no |
| 3 — nice | **Jina** | `s.jina.ai` search + a key for the page reader (higher limits) | 10M tokens **once** (~1,000 searches), 100 req/min | no |
| 3 — nice | **Firecrawl** | search (open source, self-hostable) | free monthly credits (search costs 2 credits per 10 results) | no |
| 3 — nice | **OpenRouter** | extra free models | 20 req/min; 50 req/day (1,000/day after buying $10 credit) | no |
| 3 — nice | **Serper** | Google results | 2,500 queries **once** (not monthly) | no |
| 4 — optional | SambaNova | DeepSeek-V3.2 for free | 20 req/min, **20 req/day**, 200K tokens/day | no |
| 4 — optional | Cloudflare Workers AI | small extra pool | 10,000 neurons/day | no |
| 4 — optional | Cohere | `command-a` model | 1,000 calls/month (trial key) | no |
| 4 — optional | Puter | GPT/Claude/Gemini via one token | your Puter account's free monthly allowance (size not published); you pay Puter if you exceed it | no |
| built in | **Pollinations** (no key) | works with zero keys, so the app always has a model | anonymous: **1 reply per 30 s per IP** (HTTP 402 `FREE_LIMIT`), model `gpt-oss-20b`; prompts go to a public third-party API. Off: `FRL_POLLINATIONS=0`. A free key from https://enter.pollinations.ai raises limits (`POLLINATIONS_API_KEY`) | no |
| skip | ~~GitHub Models~~ | **retired 2026-07-30** | — | — |
| skip | Hugging Face | free accounts get **no** monthly inference credits now | — | — |
| skip | Brave Search | free plan removed Feb 2026: $5/month credit (~1,000 searches) but **a card is required** and use above it is billed. Works in the app (`BRAVE_API_KEY`) if you accept that | — | yes |
| skip | Google Custom Search JSON API | **closed to new customers**; shuts down 2027-01-01 | — | — |

**Minimum that works well: Gemini + Groq + LangSearch + Tavily. Best free setup: add SearXNG, Mistral, Cerebras, NVIDIA, Exa and Jina.**

## How the app routes between them

```
DEEP role  (issue tree, retries after failed checks, final memo — few calls, needs the smartest model)
  gemini → mistral → cerebras → groq → nvidia → sambanova → openrouter → cloudflare → cohere → puter → pollinations → ollama

FAST role  (research every sub-question — many calls, needs volume)
  groq → gemini → mistral → nvidia → cerebras → openrouter → cloudflare → sambanova → cohere → puter → pollinations → ollama

REVIEWER   always a different provider than the one that wrote the answer
ON 429/402 that provider cools down (honours Retry-After or the "retry after" text); the next one answers;
CUT OFF    a reply stopped by the token limit is re-asked with double the budget (up to 16K);
           if every provider is cooling, the app waits up to 65 s, then stops cleanly (press Run / resume later)
SEARCH     every keyed engine takes turns: query 1 starts at langsearch, query 2 at tavily, query 3 at exa, …
           (langsearch, tavily, exa, linkup, jina, firecrawl, serper, brave, searxng); if one fails the next answers;
           an engine that says 401/402/403/429/432 is benched for 1 hour; wikipedia is the last resort;
           pages that return too little text are re-read through the Jina reader
GAP LOOP   a sub-answer that fails the checks: its "gaps" become new searches (new URLs only),
           then the deep model retries with the extra evidence — up to 3 attempts per sub-question
```

Providers without a key are skipped automatically. To change the order:
`export FRL_DEEP_ORDER="mistral,gemini,groq"` and/or `export FRL_FAST_ORDER="groq,cerebras,gemini"`.

## Step by step (Mac)

**Step 1. Create the keys.** Open each link, sign in (Google/GitHub sign-in works for most), and create a key. Copy it.

| # | Where to click | What to copy |
|---|---|---|
| 1 | https://aistudio.google.com/apikey → **Create API key** | key starting `AIza…` |
| 2 | https://console.groq.com/keys → **Create API Key** | key starting `gsk_…` |
| 3 | https://app.tavily.com → API Keys (a default key is already there) | key starting `tvly-…` |
| 3a | https://langsearch.com → sign in → **API Keys** → create | key starting `sk-…` |
| 3b | https://jina.ai/api-dashboard → **API key & billing** (a key is shown) | key starting `jina_…` |
| 3c | https://app.linkup.so → API key | the key |
| 3d | https://www.firecrawl.dev/app/api-keys | key starting `fc-…` |
| 4 | https://console.mistral.ai/api-keys → choose the free **Experiment** plan, verify phone → **Create new key** | the key |
| 5 | https://cloud.cerebras.ai → **API Keys** | key starting `csk-…` |
| 6 | https://build.nvidia.com → sign in → open any model → **Get API Key** | key starting `nvapi-…` |
| 7 | https://dashboard.exa.ai/api-keys | the key |
| 8 | https://openrouter.ai/settings/keys → **Create Key** | key starting `sk-or-…` |

**Step 2. Paste them once into the macOS Keychain.** This is the safest place: no file in the project, and no key in `~/.zshrc`.
In Finder, open the app folder and double-click **`keys.command`**. If macOS blocks it, right-click it → **Open** → **Open**. Or run it in Terminal:
```bash
cd ~/Documents/research/free-research-llm-main
./keys.command
```
It walks the list. For each line, paste the key (it stays invisible) and press **Enter**. Press **Enter** on an empty line to skip a key, or type `-` to delete a saved one. You can run it again any time to add or replace keys.

Search keys only (model keys already saved): `./keys.command search`.

**Step 2b. Optional, unlimited search: SearXNG on your Mac.** Install and open Docker Desktop (https://www.docker.com/products/docker-desktop/), wait for "Engine running", then:
```bash
./searxng.command
```
It starts the open-source SearXNG container on http://127.0.0.1:8888 (only this Mac can reach it) with JSON output on, and saves `SEARXNG_URL` in the Keychain. It restarts with Docker. Stop it: `docker rm -f frl-searxng`.

**Step 3. Start the app.** Double-click **`start.command`**, or run `npm start` in the folder. The terminal prints which keys came from the Keychain and the live route, for example:
```
keys from macOS Keychain: GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, TAVILY_API_KEY
route deep: gemini → mistral → groq
route fast: groq → gemini → mistral
```

**Step 4. Check in the browser.** Open http://127.0.0.1:4600 → **Setup**. Every key you added should show **● ready** with a model name. The **Routing** card shows the same order as above, and **Web search** shows `tavily, …, wikipedia`.

**Without a Keychain (Linux/Windows, or if you prefer):** use `export GEMINI_API_KEY="…"` lines in your shell profile, or paste a key in **Setup → Paste a key for this session**. Session keys are forgotten when the app stops.

## Settings worth knowing

| Variable | Default | Use |
|---|---|---|
| `FRL_DEEP_ORDER`, `FRL_FAST_ORDER` | see route above | change which provider answers first |
| `FRL_GEMINI_DEEP_MODEL` (any provider: `FRL_<ID>_FAST_MODEL` / `_DEEP_MODEL`) | auto-picked from the provider's model list | pin a model, e.g. `FRL_GROQ_DEEP_MODEL=openai/gpt-oss-120b` |
| `FRL_PAID_CALL_LIMIT` | `0` (paid DeepSeek never used) | allow N paid calls per session |
| `FRL_JINA_READER` | `1` | set `0` to stop re-reading thin pages through r.jina.ai |
| `FRL_WIKIPEDIA_LANG` | `en` | e.g. `cs`, `de`, `pl` for local-language Wikipedia |
| `PORT` | `4600` | if the port is busy |

## Sources

- Groq free limits: https://console.groq.com/docs/rate-limits
- Gemini limits (dashboard-based): https://ai.google.dev/gemini-api/docs/rate-limits
- Cerebras free trial limits and `/v1/models`: https://inference-docs.cerebras.ai/support/rate-limits · https://inference-docs.cerebras.ai/api-reference/models
- OpenRouter free model limits: https://openrouter.ai/docs/api/reference/limits
- Mistral free Experiment plan: https://help.mistral.ai/en/articles/450104-how-can-i-try-the-api-for-free-with-the-experiment-plan · API: https://docs.mistral.ai/api/
- NVIDIA build (base URL, ~40 RPM): https://build.nvidia.com · https://yangmao.ai/en/providers/nvidia-build/api-pricing/
- SambaNova free tier and base URL: https://docs.sambanova.ai/docs/en/models/rate-limits · https://docs.sambanova.ai/docs/en/get-started/api-keys-urls
- Cloudflare Workers AI free neurons and OpenAI endpoint: https://developers.cloudflare.com/workers-ai/platform/pricing/ · https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- Cohere compatibility API: https://docs.cohere.com/docs/compatibility-api · trial limits: https://docs.cohere.com/docs/rate-limits
- Puter OpenAI-compatible endpoint and user-pays model: https://developer.puter.com/tutorials/use-openai-sdk-with-puter/ · https://docs.puter.com/user-pays-model/ · https://developer.puter.com/pricing/
- Pollinations anonymous endpoint (tested live 2026-10-17: `GET https://text.pollinations.ai/openai/models`, 402 FREE_LIMIT text): https://text.pollinations.ai/openai
- GitHub Models retirement: https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models
- Hugging Face credits: https://huggingface.co/docs/inference-providers/pricing
- Tavily free credits: https://docs.tavily.com/documentation/api-credits
- LangSearch API and free plan: https://docs.langsearch.com/api/web-search-api.md · https://docs.langsearch.com/limits/api-limits.md
- Linkup search endpoint and credits: https://docs.linkup.so/pages/documentation/endpoints/search/overview.md · https://docs.linkup.so/pages/documentation/platform/pricing.md
- Jina free tokens and limits: https://jina.ai/reader · https://apis.io/rate-limits/jina-ai/jina-ai-rate-limits/
- Firecrawl search: https://docs.firecrawl.dev/api-reference/endpoint/search
- SearXNG Docker and JSON format: https://docs.searxng.org/admin/installation-docker.html · https://docs.searxng.org/admin/settings/settings_search.html · https://docs.searxng.org/admin/settings/settings_server.html
- Brave free tier removal: https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/
- Google Custom Search API closure: https://brave.com/learn/google-api-shutdown/
- Exa API: https://exa.ai/docs/reference/search · free credits: https://www.tinyfish.ai/blog/exa-pricing
- Serper: https://serper.dev/
- Brave plan change: https://parallel.ai/articles/best-free-web-search-api
