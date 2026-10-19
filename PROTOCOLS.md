# Protocols

The rules this app enforces in code. A model can propose; only these mechanics decide what becomes output.
Each row names the code that enforces it and the test that proves it.

## 1. Research protocol (every sub-question)

| Step | What happens | Enforced in |
|---|---|---|
| 1 Read | Pages listed in the node's "pages to read directly" are fetched first | `ResearchEngine.gatherSources` |
| 2 Search | Search engines take turns per query; an engine out of quota (401/402/403/429/432) is benched for 1 h; off-topic Wikipedia hits are dropped | `SearchService.rotation`, `isRelevant` |
| 3 Scrape | Top 5 pages are fetched; thin pages are re-read through the Jina reader; links on every page are kept, listing-like links first | `SearchService.readPage`, `extractLinks` |
| 4 Answer | Fast model answers from the evidence only, following the node's instructions | `researchPrompt` |
| 5 Review | A different provider critiques the answer | `ResearchEngine.critique` (`avoid`) |
| 6 Gate | Mechanical checks (section 2) grade the answer | `verifyFinding` |
| 7 Retry | On weak/unsupported: the answer's gaps become new searches, then the deep model retries; max 3 attempts | `searchGaps`, `MAX_ATTEMPTS` |
| 8 Roll up | A parent takes its weakest child's grade | `ResearchEngine.rollup` |
| 9 Deliver | Only items from verified/supported nodes are collected; the expected-result checks run on them | `collectDeliverables`, `AcceptanceChecker` |

## 1b. Marketplace data protocol

- Listing data comes from built-in connectors, not from the model: DE kleinanzeigen.de, CZ bazos.cz and aaaauto.cz (`src/search/marketplaces.mjs`). A node asks for it with `listings: {countries, make, model, minEur, maxEur}`.
- Every page is checked against the site's robots.txt first (`RobotsPolicy`, RFC 9309 longest match); disallowed pages are never fetched. Price filters that robots.txt forbids (kleinanzeigen `/*/preis:*`, bazos `cenaod=`) are applied in code instead; sauto.cz forbids bots entirely and is not used.
- Listings are read from schema.org structured data when the page has it, otherwise from the listing card; prices are converted at ECB rates; median, range and count are computed by code; each fetch is stored in `data/market/` so the price trend builds up over time.
- The result is a `data` source whose rows and links the gates trust; items must still be copied from those rows.

## 2. Gate protocol (the model cannot override these)

| Gate | Fails when | Effect |
|---|---|---|
| answer | no answer | unsupported |
| citations | a cited source id was never retrieved | unsupported |
| item-links | an item URL was not on any fetched page | unsupported |
| calculation | the formula, recomputed by code, does not equal the stated result | unsupported |
| concrete | the answer evades ("cannot determine", "no verifiable…") or lacks a number where one is expected | weak |
| numbers-sourced | a number has no source and is not marked an assumption | weak |
| independent-sources | "high" confidence with fewer than 2 source domains | weak |
| critique | the independent reviewer finds a major flaw | weak |
| expected result | item count, live deep links, value in range (currency converted at ECB daily rates), required words | scored, shown in Report |

Grades: **verified** = all gates pass and 2+ independent domains (or your data); **supported** = all pass; **weak**; **unsupported**.
Tests: `tests/research/verify.test.ts`, `tests/research/acceptance.test.ts`.

## 3. Change protocol (chat, edits, suggestions)

- Four chats with separate threads: piece, research, results, app ([CONCEPT.md](CONCEPT.md)). A message about the app itself sent to a research chat is answered by the App chat and not stored in the research (`NodeChat.send`, `scope: "app"`).
- **The App chat cannot create, delete, loop or run anything by itself.** It may open a research, stop one, or show device links. A new research, a deletion, a loop and a terminal command are proposals that run only when you press Confirm or Run in Terminal (`validAppActions`, `AppChat.decide`). Test: `tests/appchat.test.ts`.
- **Reply audit** on every chat reply: unknown links and key values are removed; unknown commands, placeholders and claimed-but-not-run actions are flagged; one revision, then a visible ⚠ mark (`ReplyAudit`). Test: `tests/chat/reply-audit.test.ts`.

- The chat can only **edit, add, remove, expand, suggest, re-research** existing nodes. It cannot write answers, grades or sources. Unknown action types and unknown node ids are dropped by `validActions`.
- Any change resets that node, its ancestors and every node that depends on it to *pending*, so nothing stale survives (`resetWithAncestors`).
- Sub-issue suggestions are researched first: a search runs, the model proposes, and code marks each suggestion **quoted** (its quote is found in a cited page), **cited**, or **not grounded** (`gradeSuggestion`).
- **Your chat message has priority**: if it changes the tree while a run or the loop is active, the app pauses it (the loop reverts its unfinished trial), applies your change, then resumes for the remaining time. Reverts never overwrite the chat.

## 4. Self-improving loop protocol

1. Baseline: research the whole tree, score it. Score = 0.6 × expected-result score + 0.4 × node-grade score (node-grade score only, if no expected result is set).
2. For each target (structure first, then the weakest leaves): the model proposes one change; code applies it.
3. **Piece test**: the changed leaf is re-researched; if its grade drops, revert immediately.
4. **Whole test**: the full model re-runs; keep only if the score rises by more than 0.001, otherwise revert to the exact previous project.
5. Stop at the time limit or on Stop (checked before and after every step, so Stop takes effect within one model call). On a quota error: revert, pause up to 5 min, continue.
6. **Scope:** the whole research, or only the pieces the user ticked (and their sub-pieces); with a scope, only those pieces are changed and scored (`inScope`, `scopeScore`).
7. **Regression gate:** after the piece test and the whole test, every regression check that passed before must still pass, or the change is reverted (`regressions`, outcome `reverted-regression`).
Every trial is recorded with before/after score (`project.improve.trials`). Tests: `tests/research/improve.test.ts`, `tests/research/specs.test.ts`.

## 4b. Regression check protocol

- Piece and Research chat messages carry a request and a desired output (both required). The model proposes machine checks from the desired output only; code normalizes them (`normalizeSpec`) and stores them on the piece or on Q (`addSpec`).
- After every run, code evaluates every check against the piece's answer, claims, items, calculation and grade (Q: memo and delivered items) and marks passing, not met, or regressed (`evaluateAll`). Results appear in the piece report and in Gates & logs.

## 4c. App change protocol

- App changes are requested in the App chat and become tickets (`data/changes/C<n>.md`) only on the user's button (`ChangeBook`). The free-model coder (`FreeCoder`, `src/coder/`) implements a ticket in a sandbox copy, runs `npm run quality` there, retries with the failure up to 4 times, and copies the files into the app only on PASS, with a backup for Undo (`POST /api/changes/C<n>/run`, `/undo`). It cannot edit the gate, itself, auth, secrets, the terminal or `package.json`, and a change that lowers the test count fails before the gate runs. `--claude` hands a ticket to Claude Code instead. Tests: `tests/coder/*.test.ts`, `tests/changes.test.ts`.

## 5. Logging and audit protocol

| Record | Where |
|---|---|
| Every project event (search, grade, retry, chat, loop trial) | `data/logs/project-<id>.jsonl` and `GET /api/projects/<id>/logs` |
| Every model call (provider, model, purpose, ok/error, ms) | `data/logs/model-calls.jsonl`, `GET /api/logs/model-calls` |
| Sessions, runs, verdicts, expected-result scores, loop start/end | `data/logs/history.jsonl`, **History** tab, `GET /api/history` |
| Knowledge record: facts (verified), claims (supported), hypotheses (weak) with re-checkable evidence | `GET /api/projects/<id>/knowledge` |
| Quality gate verdicts | `data/logs/quality.jsonl` |

## 6. Ship protocol (quality gate)

`npm run quality` must pass before anything is committed; the `.githooks/pre-commit` hook runs it (`npm install` or `npm run hooks` activates the hook). The gate, not the author, reports the result:

| Gate | Checks |
|---|---|
| syntax | every module and the UI script parse |
| secrets | no API key patterns in any tracked file (plus `gitleaks` when installed) |
| noComments | no comments in source |
| testsPresent | every logic module in `src/` has `tests/<same path>.test.ts` |
| e2e | Playwright on iPhone 14 (WebKit) and Pixel 7 (Chromium): home, tree, piece chat, App assistant proposal + Confirm, Results tab + chat with a file, Terminal running a command |
| tests | the full Vitest suite passes |

## 7. Keys and privacy protocol

- Keys live only in the system key store (macOS Keychain, Windows user environment, Linux secret-tool, or systemd encrypted credentials on a server) or the shell environment; never in a file. The secrets gate enforces it. `node src/frl.mjs keys …` reads and writes them on every system.
- The server binds to `127.0.0.1` unless remote access is on (`node src/frl.mjs install` or `start --remote`); then every other device needs the access token. A request forwarded by a local proxy (Tailscale Funnel, tunnels: `X-Forwarded-*`, `Forwarded`, `Tailscale-*` headers) is never treated as this computer (`AccessGate.isLoopback`); `FRL_BEHIND_PROXY=1` distrusts loopback entirely. SearXNG binds to `127.0.0.1:8888`.
- **Terminal:** a real shell for whoever passes the access gate. The WebSocket also requires the page's `Origin` to match the host, so another website cannot open it from your browser (`sameOrigin`). The shell does not get the access token in its environment. `FRL_TERMINAL=0` turns it off. Tests: `tests/terminal/socket.test.ts`, `tests/auth.test.ts`.
- No paid provider is wired in.
- Scraping reads public pages only; no logins, no anti-bot evasion. For sites that block readers, upload a CSV export.

## Credits

Methods, not code, were taken from: GPT Researcher (plan/search/scrape), Stanford STORM (perspective questions), LangChain open_deep_research (gap-driven reflection), FrugalGPT (cascade routing), Self-Consistency and Chain-of-Verification (cross-checking), and mikoshi-construct 0.43.0 (gate-reported quality, secret scanning, commit guard, run ledger, facts/claims/hypotheses knowledge record).
