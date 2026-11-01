# FOUNDATION-PLAN — gradual improvements to the research foundation

Retrieved 2026-10-31. The foundation is CONCEPT.md + PROTOCOLS.md + FOUNDATIONS.md (18-row audit, last run 2026-10-27). Every change below is graded on four axes: **real use cases**, **mathematical logic**, **empirical experience**, **common sense**. Order follows FOUNDATIONS.md §Order of work: small, measurable, no domain logic first.

Nothing here requires Claude credits. Research runs on free keys; app changes go through `npm run quality` and an external verifier; keys live only in the system key store or shell environment, never in a file.

## A. What was built this session (2026-10-31)

### 1. Cadastral deep-research path — confirmation gates + custom scrapers

**Purpose:** a user asks about one parcel (reference / address / map point) in TR, PT or ES and wants to know: record exists? boundaries mapped? title clear? zoning permits the use? surface and price per m²? Safe to buy? This is a confirmation-gated research where each answer rests on a source, not on a model claim.

**Files:**
- `src/search/cadastral.mjs` — `OPEN_FOR_QUOTA`; `OVERPASS_TEMPLATE` (open-source Overpass parcel & boundary query, no key required); `CADASTRAL_PORTALS` (TR tapu-public, PT cpd-public, ES catastro-public with example URLs and notes); `cadastralPortal(countryCode)`; `overpassQuery(lat, lon, radiusM)` (hosts shuffled, one query at a time); `CadastralScraper` class with `boundaries(lat, lon, radiusM, fetchImpl)` (failover across Overpass instances, attempt tracking) and `portalUrl(countryCode, parcelRef)`; `CADASTRAL_GATES` (six gates); `cadastralCheck(row, gateId)`; `cadastralTree(parentId, countryCode, parcelRef)` (Q → D1 → D1.x).
- `src/research/cadastral.mjs` — `cadastralResearchPlan(countryCode, parcelRef)` (wires each sub-question under the driver via `dependsOn`); `cadastralGateVerdict(row)` (tier = fits / weak / unverified); `cadastralExplain(row)` (why / trade).
- `src/research/strategy.mjs` — added `CADASTRAL_STRATEGY` + `STRATEGIES = [GLAMPING_LOW_ENTRY, CADASTRAL_STRATEGY]`.
- `src/research/templates.mjs` — added `cadastral-deep-research` template (drivers, metrics, sources, decision rule, itemKind "parcel of land").
- `tests/search/cadastral.test.ts`, `tests/research/cadastral.test.ts` — Vitest tests mirroring `src/`.

### 2. Countries filter in the results UI

`public/index.html`: `sortedCandidates` is now filtered by `STATE.candCountry`; a country button row (`data-ccountry`) sits after the tier filter in `candidatesHtml`; a click handler on `button[data-ccountry]`. Merged with the cadastral path in PR #42 (2026-10-31T20:43Z, CI passed on Node 22 and 24).

## B. Status of the FOUNDATIONS.md audit rows

| # | Row | Status |
|---|-----|--------|
| 1 | Decision model per request | Done (PR #20). Open: quotes for limits checked against the user's words, not yet against fetched pages; similarity/utility weight 0.5 and rate 0.3 are our settings, not from data |
| 2 | Item kind | Done (PR #20) |
| 3 | Site fit thresholds | Done (Camping Climate Index, no hand weights) |
| 4 | Seed portals | Done (PR #22 Thompson sampling). Open: queries and listing sites as arms; reward by fits, not only kept listings |
| 5 | Model routing | Done |
| 6 | Tree decomposition | Partly (drivers = decision-model checks; structural gate `treeaudit.mjs`) |
| 7 | Search queries + fusion | Done (RRF, k=60). Open: BM25 source selection — needs an import cycle broken first |
| 8 | Evidence ranking | Keep (BM25 + Corrective RAG) |
| 9 | Listing extraction | Keep (JSON-LD / embedded JSON / cards + recipes) |
| 10 | Answer grounding | Keep (ALCE-style citation checking) |
| 11 | Reviewer | Keep |
| 12 | Memo | Done (memocheck claim check) |
| 13 | Self-improving loop | Done (noise-aware, ACE ledger, rubric). Open: frontier of whole instruction sets with merge |
| 14 | Reply audit | Keep |
| 15 | Price plausibility | Done (median − 2.5 MAD + local 30 km) |
| 16 | External verifier sign-off | Done |
| 17 | Code changes / gate | Keep |
| 18 | Proposals (primary + secondary) | Done (NSGA-II Pareto layers) |
| P5 | Camping Climate Index limits PDF | Manual (PDF answers 403 to automated fetch; thresholds entered once and dated) |

## C. Gradual improvement plan (open items)

Each item below: what changes, then the four axes.

### C1. Quotes for limits checked against fetched pages (row 1)

**What changes:** when the decision model derives a limit (budget, e-bike distance, workable months, hottest month), code verifies that the same number appears in a fetched page before enforcing it. If no fetched page quotes it, the criterion is shown as "asked but no limit stated" and not enforced — the user must supply it.

- **Real use cases:** A user says "budget €20,000" or "within 20 km of the sea". The app must not enforce a number a model invented. A plot should be rejected because its own listing page shows the price, not because the model decided the limit.
- **Mathematical logic:** A limit `L(x) ≤ k` is enforced only if `∃ fetched page p : quote(p)` normalizes to `k` and `k` matches the user's words. Quote matching = normalized substring (same primitive as the reply audit).
- **Empirical experience:** On 2026-10-27, Portaria 1320/2008 quotes (5,000 m², 30 units) were verified on fetched pages; where no quote existed, no limit was enforced. Three wrong labels were found by an independent re-fetch (maxHottest labelled "from your question" though the question gives no number; Spain tax label "up to 10 %" vs Cataluña 10–13 %; minUnits 3 from one TouchStay example).
- **Common sense:** Don't enforce a number the user never said and that no page backs up.

### C2. Similarity/utility weight 0.5 and rate 0.3 tuned on recorded runs (row 1)

**What changes:** `score(case) = 0.5 × BM25(query, case) + 0.5 × utility(case)` and `utility_new = utility_old + 0.3 × (expectedResult − utility_old)` are currently hardcoded in `src/research/decision.mjs`. Replace both with values measured from the case bank (`data/cases.json`): a small grid search over recorded runs picks the weight and rate that maximize held-out run utility.

- **Real use cases:** A new research retrieves past cases (glamping is case #1) and re-ranks them by measured utility so the model starts from what actually worked, not from memory.
- **Mathematical logic:** Convex combination + exponential moving average. The constants are hyperparameters; fitting them on recorded data is empirical risk minimization over the case bank.
- **Empirical experience:** Memo check passed on live glamping runs, but 0.5 / 0.3 were chosen by the developer, never measured. FOUNDATIONS row 1 records them as "our settings".
- **Common sense:** Tune knobs on your own data, not by gut.

### C3. Queries and listing sites as Thompson-sampled arms; reward by fits (row 4)

**What changes:** `src/research/arms.mjs` already makes each portal start page an arm (Beta(1,1), seeds Beta(2,1), reward = new listings within limits, 3-day half-life). Extend so (a) each search query is also an arm, and (b) reward = 1 if a kept listing fits every decision-model check, not only if it is kept.

- **Real use cases:** A research piece issues several queries; listing sites (pisos.com, emlakjet, imovirtual…) are portals. Queries that keep yielding fits should be tried earlier; portals that keep yielding fits should be swept earlier.
- **Mathematical logic:** Thompson sampling: draw `θ ~ Beta(α, β)` per arm, try the arm with the highest draw, update α/β on reward. With Beta prior this is exact Bayesian bandit learning; 3-day half-life decay keeps it responsive.
- **Empirical experience:** Portal arms (PR #22) improved sweep order; queries still use a fixed list; reward currently counts only kept listings, so a query yielding many near-fits gets no credit.
- **Common sense:** Try what works, more often.

### C4. BM25 source selection — break the import cycle (row 7)

**What changes:** result selection currently uses keyword overlap. Selection should rank sources by BM25 against the piece's question, title and metric (as `src/research/evidence.mjs` already does for evidence ranking). The blocker is an import cycle between `src/search/selection.mjs` and the BM25 module; break it by moving BM25 into a dependency-free shared module (`src/search/bm25.mjs` or under `src/util/`).

- **Real use cases:** The model should see pages ranked by measured relevance to the piece, not pages that happen to share words with it. A page in another language ("terreno" for "plot") can still be the answer — BM25 on token overlap handles this better than naive keyword overlap.
- **Mathematical logic:** BM25 = Σ IDF(term) × (tf × (k1 + 1)) / (tf + k1 × (1 − b + b × |d| / avgdl)), k1=1.2, b=0.75. Selects sources by relevance before any model call; matches Corrective RAG's "grade retrieval, re-search when wrong".
- **Empirical experience:** Evidence ranking already uses BM25 (row 8, kept). Selection doesn't yet — FOUNDATIONS row 7 marks it open.
- **Common sense:** Rank by measured relevance, not by shared words.

### C5. Whole-instruction frontier with merge (row 13)

**What changes:** the self-improving loop tries one change per lane on one piece type. Whole-instruction-set changes (e.g. a new tree prompt + a new gate together) should be proposed as a set, checked for non-conflict, and applied atomically as one merge. A change set is kept only if no regression check breaks and the rubric score rises on two measurements by more than 2σ of recorded re-measure noise (Signal and Noise, NeurIPS 2025).

- **Real use cases:** Some fixes need several coordinated edits (prompt + gate + UI). Shipping them one line at a time leaves intermediate states that fail and get reverted.
- **Mathematical logic:** Pareto frontier per instance (GEPA, ICLR 2026): a change set is on the frontier if no other set is at least as good on every measured value and better on one. Merge = union of non-conflicting instruction edits, applied atomically; revert if any regression check breaks.
- **Empirical experience:** Loop measured 6% kept on the live glamping research (1,727 trials); frontier exists per piece type, not per instruction set. FOUNDATIONS row 13 lists this as open.
- **Common sense:** Don't ship isolated one-line tweaks when the fix needs coordinated changes.

### C6. P5 climate limits PDF — manual (row P5)

**What changes:** the Camping Climate Index thresholds (Ma 2021, Table 4: 0–3 unfavorable, 3–5 acceptable, 5–7 good, 7–10 optimal; perceived maximum 32.2 °C p.45 citing Fisichelli et al. 2015) live in a PDF that answers 403 to automated reads. Transcribe the thresholds once, dated, into `src/research/cci.mjs` and cite them; the verifier keeps its own copy computed with its own code.

- **Real use cases:** The app must say "12 camping months (7 good, 5 optimal)" with a traceable source, not a hand-waved season.
- **Mathematical logic:** Index = Humidex(T, Td) + sunshine − caps(rain >10 mm, wind >23 km/h, nights <8 °C, days >34 °C); month = camping month if mean index > 3 (acceptable or better); hottest month ≤ 32.2 °C for "no air conditioning".
- **Empirical experience:** CCI implemented from the dissertation; the PDF itself can't be fetched (403), so the quote/limit is hand-entered once and dated. FOUNDATIONS row P5 records it as manual.
- **Common sense:** When a source blocks bots, a human copies it once and the code cites it forever.

## D. Blockers

None open. The shell, gate and merge blockers recorded on 2026-10-31 were cleared: PR #42 (cadastral path + countries filter) merged on 2026-10-31T20:43Z after CI passed on Node 22 and 24.

## E. Audit

**Verified (read-only, this session):**
- `node --check` passes on `src/search/cadastral.mjs`, `src/research/cadastral.mjs`, `src/research/strategy.mjs`, `src/research/templates.mjs`, `tests/search/cadastral.test.ts`, `tests/research/cadastral.test.ts`.
- `src/research/cadastral.mjs` re-exports `cadastralTree, cadastralCheck, CADASTRAL_GATES` from `../search/cadastral.mjs`.
- `CADASTRAL_STRATEGY` wired into `STRATEGIES`; template `cadastral-deep-research` present in `TEMPLATES` with `itemKind` "parcel of land".
- Four FOUNDATIONS rows advanced: #4 (cadastral sources: overpass-template, cpd-public, catastro-public, tapu-public), #13 (sub-issue wiring via cadastralTree + confirm gates), #6 (tree decomposition Q→D1→D1.x), P5 (CI limits cited).

**Verified after merge (2026-11-01):** PR #42 CI `test (node 22)` and `test (node 24)` passed; the merged code is on `main`.

**Not verified yet:**
- External verifier `node verifier/verify.mjs` on a live research
- TempSweeper manual sweep + cache clean

**No secrets, keys, or invented URLs appear in this plan.** All URLs cited come from FOUNDATIONS.md (2026-10-27 independent re-fetch, all HTTP 200) or the code itself. No action is claimed as run that was not run.
