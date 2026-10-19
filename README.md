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
           SEARCH   web (LangSearch / Tavily / Exa / Linkup / Jina / Firecrawl / SearXNG / Wikipedia, rotated) + gap re-search + your CSV (D1)
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

## What it does

- Takes any question plus an **expected result**, builds an issue tree, and lets you review it first.
- Each node is researched by free models from real web pages, then **graded by code** (citations, links seen on fetched pages, recomputed formulas, evasive answers, reviewer). See [PROTOCOLS.md](PROTOCOLS.md).
- **Chat** with any node to change it; **researched suggestions** for new sub-issues; **re-research** any piece.
- **Self-improving loop** with a time limit: keeps only changes that raise the measured score.
- **History**, JSONL logs and a facts/claims/hypotheses **knowledge record** per project.
- `npm run quality` gate + pre-commit hook. Build history: [SESSION-LOG.md](SESSION-LOG.md).

## Quick start

You need Node.js 20+ on macOS, Windows or Linux. Runtime dependencies: `ws` and xterm.js for the in-app terminal, plus `node-pty` (optional) for a full shell.

```bash
git clone https://github.com/bezgolovyponch/free-research-llm.git
cd free-research-llm
npm install
node src/frl.mjs keys setup      # paste free keys once (see KEYS.md); stored in the system key store
node src/frl.mjs start           # → http://127.0.0.1:4600
```

Double-click `start.command` (macOS) or `start.cmd` (Windows) instead, if you prefer. Windows step by step: **[WINDOWS.md](WINDOWS.md)**. Always on in a free cloud server, open from any device: **[CLOUD.md](CLOUD.md)**. What the app is, its four chats and the reply audit: **[CONCEPT.md](CONCEPT.md)**. To see the whole flow without any key, run `npm run demo`. It uses scripted answers and labels everything DEMO.

From the terminal you can use the same engine without the UI:

```bash
npm run ask -- "Is a 6-tent glamping site in Šumava profitable on €250k?" --template glamping-location --set budget=€250k
npm run ask -- "Which RAV4 specs clear €1,500 margin DE→PL?" --csv listings.csv
```

Reports are written to `reports/<project>.md`.

**[GUIDE.md](GUIDE.md)** has the exact step-by-step instructions. Anyone changing the app follows **[AUDIT-PROTOCOL.md](AUDIT-PROTOCOL.md)**.

## Keys and routing

**[KEYS.md](KEYS.md)** lists which free keys to get (verified 2026-10-17), the exact clicks for each, and how the router uses them. Short version: get **Gemini + Groq + LangSearch + Tavily**, then click **Terminal → Add keys** in the app (or run `node src/frl.mjs keys setup`) to save them in the system key store. Optional extras: Mistral, Cerebras, NVIDIA, Exa, OpenRouter, SambaNova, Cloudflare, Cohere, Puter.

Every key has numbered steps inside the app too: open **Models & router** and press **How to get it** on a provider or search card (the same steps print in the terminal from `node src/frl.mjs keys list` and `keys set NAME`; `src/llm/guides.mjs`, checked 2026-10-19).

Supported providers: Gemini, Groq, Cerebras, Mistral, NVIDIA, SambaNova, OpenRouter (`:free` only), Cloudflare Workers AI, Cohere, Puter, Ollama (local), and any custom OpenAI-compatible endpoint. Free only: no paid provider is wired in. Search: LangSearch, Tavily, Exa, Linkup, Jina, Firecrawl, Serper, Brave, SearXNG (local Docker, `node src/frl.mjs searxng`) and Wikipedia, plus the Jina reader for pages that return too little text.

The **deep** role (issue tree, retries, memo) and the **fast** role (research every sub-question) each have their own provider order, and the reviewer always uses a different provider. Keys are read from the shell environment first, then from the macOS Keychain. They are never read from or written to a project file.

Model IDs are not hard-coded. Each provider's `/models` list is read at start and the best match from a preference list is picked, so renamed free models keep working. When a free quota returns HTTP 429, the router moves to the next provider. It cools the exhausted one down (honouring `Retry-After`), and if every provider is cooling it waits up to 65 seconds before giving up. Keys pasted in the Setup tab live only in server memory.

## Layout

| Path | Role |
|---|---|
| `src/server.mjs` | HTTP API + UI + live event stream (SSE), bound to 127.0.0.1 |
| `src/cli.mjs` | one-shot terminal runner |
| `src/app.mjs` | composition root: providers, search, store, engine |
| `src/llm/` | provider presets, OpenAI-compatible client, failover router, scripted demo provider |
| `src/coder/` | app change implementers: sandbox copy, Claude Code runner, free-model coder, quality gate before anything reaches the app |
| `src/research/` | engine, prompts, issue tree, mechanical verifier, safe calculator, domain templates, JSON extraction |
| `src/search/` | search backends, per-query rotation, quota benching, page text fetch |
| `src/secrets.mjs` | reads and writes keys in the system key store: macOS Keychain, Windows user environment, Linux secret-tool or systemd encrypted credentials |
| `src/frl.mjs` | the `frl` command: start, always-on service (macOS, Windows, Linux), links, keys, update, restart |
| `src/appchat.mjs` | the App chat: grounded in app facts and guides, direct actions open/stop/links, everything else a proposal you confirm; app changes run with Claude Code or the free models |
| `src/chat/` | reply audit (links, secrets, commands, claims), guide search, file reading (photos, PDFs, audio via a free vision model) |
| `src/terminal/` | shared shell sessions (node-pty, or a basic piped shell), the WebSocket bridge with origin check, the command buttons |
| `src/data/csv.mjs` | CSV parsing + column profiling (your data becomes source D1) |
| `public/index.html` | the UI (single file; the terminal loads xterm.js from the app itself, no CDN) |
| `tests/` | Vitest suites (`npm test`, needs `npm install` once) |

## Honest limits

- Free models are weaker than frontier models. The checks catch invented sources and bad arithmetic, but they cannot prove that a cited page says what the claim says. The reviewer pass reduces that risk without removing it.
- Wikipedia-only search is thin for prices and listings. Add free LangSearch and Tavily keys (or run `node src/frl.mjs searxng`) for real web results, or upload listings as CSV.
- Tax and legal answers are research, not advice. Confirm with a licensed advisor before filing.
