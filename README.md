# Free Research LLM

Ask one analytical question and get back a decomposed, source-checked decision memo. It runs locally on free model quotas.

- **Cars arbitrage:** "Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland? Which specs clear €1,500 per car?"
- **Glamping location:** "Which Czech region gives a 6-tent glamping site the best payback on €250k?"
- **Taxes:** "Flat-rate tax, lump-sum expenses or an s.r.o. for a Czech IT freelancer on €70k in 2026?"
- **Anything else** you can state as a decision: market size, pricing, location, buy-or-build.

```
question ──► DECOMPOSE (deep model)         MECE issue tree: 3-6 drivers × 2-4 sub-questions,
              │                              each with hypothesis, metric, method, search queries,
              │                              dependencies, impact × uncertainty priority
              ▼
         for each sub-question, in dependency order:
           SEARCH   web (Tavily / Brave / SearXNG / Wikipedia) + your CSV (source D1)
           ANSWER   fast free model, every number cited [S#] or labelled an assumption
           REVIEW   a different provider critiques it (verifier ≠ doer)
           CHECK    mechanical: cited ids exist · numbers sourced · calculation recomputed by machine
                    · high confidence needs 2+ independent domains · no major reviewer objection
           ESCALATE fails checks → retried once on the deep model with the failures (cheap-first cascade)
              ▼
         ROLL UP drivers ──► MEMO: verdict (GO / NO-GO / GO-IF), key numbers, scenarios,
                              what flips the decision, risks, open questions, next steps
```

Grades: **verified** · **supported** · **weak** · **unsupported**. The grade comes from the checks, never from the model's own confidence.

## Quick start

You need Node.js 20+. There are no runtime dependencies.

```bash
git clone https://github.com/bezgolovyponch/free-research-llm.git
cd free-research-llm
./keys.command                   # paste free keys once (see KEYS.md); stored in macOS Keychain
npm start                        # → http://127.0.0.1:4600
```

On a Mac you can double-click `start.command` instead. To see the whole flow without any key, run `npm run demo`. It uses scripted answers and labels everything DEMO.

From the terminal you can use the same engine without the UI:

```bash
npm run ask -- "Is a 6-tent glamping site in Šumava profitable on €250k?" --template glamping-location --set budget=€250k
npm run ask -- "Which RAV4 specs clear €1,500 margin DE→PL?" --csv listings.csv
```

Reports are written to `reports/<project>.md`.

**[GUIDE.md](GUIDE.md)** has the exact step-by-step instructions. **[AUDIT.md](AUDIT.md)** explains what was wrong with the tour-business calibration (FREECC) and what changed.

## Keys and routing

**[KEYS.md](KEYS.md)** lists which free keys to get (verified 2026-10-17), the exact clicks for each, and how the router uses them. Short version: get **Gemini + Groq + Tavily**, then double-click **`keys.command`** to save them in the macOS Keychain. Optional extras: Mistral, Cerebras, NVIDIA, Exa, OpenRouter, SambaNova, Cloudflare, Cohere, Puter.

Supported providers: Gemini, Groq, Cerebras, Mistral, NVIDIA, SambaNova, OpenRouter (`:free` only), Cloudflare Workers AI, Cohere, Puter, Ollama (local), any custom OpenAI-compatible endpoint, and DeepSeek (paid; used only if `FRL_PAID_CALL_LIMIT` > 0). Search: Tavily, Exa, Serper, Brave, SearXNG and Wikipedia, plus the Jina reader for pages that return too little text.

The **deep** role (issue tree, retries, memo) and the **fast** role (research every sub-question) each have their own provider order, and the reviewer always uses a different provider. Keys are read from the shell environment first, then from the macOS Keychain. They are never read from or written to a project file.

Model IDs are not hard-coded. Each provider's `/models` list is read at start and the best match from a preference list is picked, so renamed free models keep working. When a free quota returns HTTP 429, the router moves to the next provider. It cools the exhausted one down (honouring `Retry-After`), and if every provider is cooling it waits up to 65 seconds before giving up. Keys pasted in the Setup tab live only in server memory.

## Layout

| Path | Role |
|---|---|
| `src/server.mjs` | HTTP API + UI + live event stream (SSE), bound to 127.0.0.1 |
| `src/cli.mjs` | one-shot terminal runner |
| `src/app.mjs` | composition root: providers, search, store, engine |
| `src/llm/` | provider presets, OpenAI-compatible client, failover router, scripted demo provider |
| `src/research/` | engine, prompts, issue tree, mechanical verifier, safe calculator, domain templates, JSON extraction |
| `src/search/` | Tavily, Brave, SearXNG, Wikipedia backends + page text fetch |
| `src/secrets.mjs` | loads missing keys from the macOS Keychain (`keys.command` writes them) |
| `src/data/csv.mjs` | CSV parsing + column profiling (your data becomes source D1) |
| `public/index.html` | the decomposition UI (single file, no external resources) |
| `tests/` | Vitest suites (`npm test`, needs `npm install` once) |
| `prompts/ONE-PROMPT.md` | the same method as a single prompt for any chat LLM |

## Honest limits

- Free models are weaker than frontier models. The checks catch invented sources and bad arithmetic, but they cannot prove that a cited page says what the claim says. The reviewer pass reduces that risk without removing it.
- Wikipedia-only search is thin for prices and listings. Add a free Tavily key for real web results, or upload listings as CSV.
- Tax and legal answers are research, not advice. Confirm with a licensed advisor before filing.
