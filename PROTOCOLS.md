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

- The chat can only **edit, add, remove, expand, suggest, re-research** existing nodes. It cannot write answers, grades or sources. Unknown action types and unknown node ids are dropped by `validActions`.
- Any change resets that node, its ancestors and every node that depends on it to *pending*, so nothing stale survives (`resetWithAncestors`).
- Sub-issue suggestions are researched first: a search runs, the model proposes, and code marks each suggestion **quoted** (its quote is found in a cited page), **cited**, or **not grounded** (`gradeSuggestion`).
- Edits are refused while a run or the self-improving loop is active (HTTP 409).

## 4. Self-improving loop protocol

1. Baseline: research the whole tree, score it. Score = 0.6 × expected-result score + 0.4 × node-grade score (node-grade score only, if no expected result is set).
2. For each target (structure first, then the weakest leaves): the model proposes one change; code applies it.
3. **Piece test**: the changed leaf is re-researched; if its grade drops, revert immediately.
4. **Whole test**: the full model re-runs; keep only if the score rises by more than 0.001, otherwise revert to the exact previous project.
5. Stop at the time limit or on Stop. On a quota error: revert, pause up to 5 min, continue.
Every trial is recorded with before/after score (`project.improve.trials`). Test: `tests/research/improve.test.ts`.

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
| tests | the full Vitest suite passes |

## 7. Keys and privacy protocol

- Keys live only in the macOS Keychain (`keys.command`) or the shell environment; never in a file. The secrets gate enforces it.
- The server binds to `127.0.0.1` only. SearXNG binds to `127.0.0.1:8888`.
- Paid providers are off: `FRL_PAID_CALL_LIMIT` defaults to 0.
- Scraping reads public pages only; no logins, no anti-bot evasion. For sites that block readers, upload a CSV export.

## Credits

Methods, not code, were taken from: GPT Researcher (plan/search/scrape), Stanford STORM (perspective questions), LangChain open_deep_research (gap-driven reflection), FrugalGPT (cascade routing), Self-Consistency and Chain-of-Verification (cross-checking), and mikoshi-construct 0.43.0 (gate-reported quality, secret scanning, commit guard, run ledger, facts/claims/hypotheses knowledge record).
