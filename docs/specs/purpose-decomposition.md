# Spec: purpose-driven decomposition, semantic and code-enforced

Branch `feat/purpose-decomposition`, base `main` 8dfaa95. Phase A (this file) is the design; phase B implements it. Replaces the planned `vague-indicators` spec. Basis: `data/handoff/HANDOFF-validation-2026-11-16.md`, `data/handoff/sim/` and `data/PURPOSE-BRIEF.md`.

## 0. Rules this design obeys

| # | Rule | Consequence in the design |
|---|---|---|
| R1 | Meaning is never decided by words (no keyword, cue, stem, overlap or token rule) | Every meaning decision (conflict asked, goal traceability, same claim, same subject, source relevance, kind) is a grounded model judgement over candidates retrieved by embeddings (§2) |
| R2 | A small free model must be able to do every task | One judgement per call, closed answer sets (option letters), ids instead of free text (`S` sentence, `C` clause, `H` hint, `P` purpose, `I` implication, `N` note, `G` goal, `Q` question, `F` fact, `M` mechanism), inputs ≤ 4,000 characters, JSON contracts, votes where one call is unreliable |
| R3 | Code does structure, retrieval, aggregation, arithmetic and every check | Models never write a quote, a grade, a count, a price statistic, a ranking or a tree edit that code applies unchecked |
| R4 | Engine universal | Nothing in `src/` names a site, a domain word, a language word list or a research id. Run-time knowledge is stored on the project (`project.scoping`, `project.purposeTree`, `project.evidence`) and in `data/hosts.json` |
| R5 | No absolute similarity threshold; vectors of two models never meet | The embedder exposes ranks only (§2.1) |
| R6 | A model proposes, code decides; the user confirms the tree | §1 stage 2, `confirmTree` |
| R7 | Free routes only, DeepSeek banned, keys from the environment or the OS key store | §2.5. Finding: no code in `src/` enforces the ban today (`src/llm/presets.mjs` lists DeepSeek models for two providers) |

Structural code that stays (it reads form, not meaning): sentence splitting and sentence ids, exact number comparison, set arithmetic on marks and votes, median and MAD on log prices, exact-string equality of two quotes, host of a URL, and `clausesOf` (splits the question at punctuation into clauses `C1…`; phase B drops its three English connective patterns and keeps the punctuation split, since clauses only need stable ids).

## 1. Stages 0 to 5 as engine steps

Model tasks are named `T<stage><letter>`. Every task goes through `ask()` or `vote()` of §2. "Fast" and "deep" are the router tiers. Unless stated, an invalid id, an option outside the closed set or unparsed JSON counts as no answer.

### Stage 0 · Scoping (Arksey & O'Malley 2005, run STORM-style, Shao et al. NAACL 2024) — `src/research/scoping.mjs`

**Input:** question, hints, `brief.regions`, `decisionModel.kind`, and the item groups already in the candidate table when a sweep ran.

| Task | Contract (input → closed JSON) | Code verifies or computes |
|---|---|---|
| T0a `subject-levels` (deep, 3 votes) | Question, kind label, up to 20 listing titles → `{"levels":["…"]}`, 2 to 5 attribute names, coarse to fine, at which value is decided for this kind | A level is kept when 2 of 3 samples name it (samples matched by `retrieveThenVerify`, §2.2). Stored as `scoping.levels`. No titles yet: levels = `[kind]` |
| T0b `perspectives` (deep, 1 call) | Question, purpose, `languages` (from `conceptLanguages(brief.regions)`) → `{"perspectives":[{"name":"…","aspects":[{"lang":"<one of languages>","phrase":"≤ 6 words"}]}]}`, ≤ 4 perspectives, ≤ 2 aspects per language | `lang` must be in the list; every market language gets at least one aspect or the call is repeated once. **Code composes the queries**: `<subject label> <phrase>`, where subject labels are the most frequent groups of the candidate table at each level (top 5), or the kind label when there is no table. The model never writes a whole query, so a query cannot be generic |
| T0c `source-relevance` (fast, 1 call per source, ≤ 12 sources) | Purpose, subject label, market names, source title, its 8 best sentences (ranked by embedding against purpose + subject, shown in page order with ids) → `{"about":"A"\|"B"\|"C"\|"D","market":"A"\|"B"\|"C","span":"S<n>"\|null}`. about: A the asked subject, B the wider class it belongs to, C a different subject, D not informative. market: A describes the asked market, B holds in any market, C describes another market | Kept only when about ∈ {A, B}, market ∈ {A, B} and `span` is a real id. Everything else is dropped with its reason and stored in `scoping.dropped`. The page's own country signal (`regionVerdict`) is passed to the model as one input line, never used as the verdict |
| T0d `scope-notes` (fast, 1 call per kept source) | Purpose, sentence block of the source (≤ 40 sentences, ≤ 4,000 characters) → `{"notes":[{"spans":["S4","S5"],"label":"≤ 8 words"}]}`, ≤ 4 notes | `quoteFromSpans`: a note with an invented id is dropped. A note's text **is** its quote, so every stored note has a quote on the page by construction. `label` is navigation only |

**Source role, fixed perspectives and diversity (scoping-coverage, 2026-11-16; changes T0b and T0c above).**

| Task | Contract (input → closed JSON) | Code verifies or computes |
|---|---|---|
| T0b2 `fixed-perspectives` (deep, 1 call) | Question, purpose, `languages` → `{"value":[{"lang","phrase"}],"cost":[{"lang","phrase"}]}` | Two perspectives are always present, with name and basis set by code (`FIXED_VIEWS`): what the result must do for the purpose, and its total cost (EN 12973 value = needs satisfied / resources; total cost of ownership). The model writes only the phrases; when none answers, each keeps one phrase set by code and the log says so. `composeQueries` gives every perspective one query before any gets a second |
| T0e `source-role` (fast, 3 votes, quorum 2, only for a source that is on subject with a real sentence id) | Purpose, subject, source title, the same sentences T0c saw → `{"role":"A"\|"B"}`. A: explains how to judge or choose (what decides, methods, criteria, risks), whatever place it describes. B: describes a market (offers, prices, availability, local rules) | The market letter of T0c is applied **only** to a source voted B (`relevanceReason(verdict, role)`). A source voted A, or with no majority (`undecided`), is kept when on subject, whatever market it describes. A market drop stores the voted role |

Sources are searched per perspective (`findSources`), merged by address, the first page of each host first, so every kept source names the perspectives that found it. `diversityOf`: at least 4 distinct hosts across at least 2 perspectives. Below that, `runScoping` composes one more round of queries from the phrases not searched yet (or asks T0b once more with the searched phrases shown), screens only pages not seen before, only while the scoping budget has room for a source, and logs `scoping thin: N hosts across M perspectives` with what it did. `scoping.enough` is that diversity check.

**Stored:** `project.scoping = { levels, languages, subjects, perspectives, queries:[{query, subject, lang, perspective, round}], screened:{purpose, subject}, sources:[{url, host, about, market, span, role, roleVotes, perspectives}], dropped:[{url, reason, role?, roleVotes?}], notes:[{id:"N1", url, quote, label}], diversity:{hosts, perspectives, minHosts, minPerspectives, rounds}, enough, embedModel, at }`.

### Stage 1 · Purpose (Keeney value-focused thinking; DecisionFlow attribute extraction) — `src/research/purpose.mjs`

| Task | Contract | Code verifies or computes |
|---|---|---|
| T1a `purpose` (deep, 3 samples) | Clauses `C1…`, hints `H1…` → `{"who":"…","outcome":"…","why":"…","anchors":["C2","H1"]}` | A sample with no valid anchor is dropped. The kept purpose is the medoid: the sample ranked nearest to the other samples by the embedder (ranks within one model; universal self-consistency for free text, Wang et al. ICLR 2023). Fewer than 2 valid samples: phase `needs-purpose`, as today. This replaces the word-overlap and "so that" test in `decision.mjs aggregate` |
| T1b `implications` (deep, 3 samples) | Purpose, clauses, hints → `{"implications":[{"attribute":"≤ 6 words","direction":"low"\|"high"\|"match","anchor":"C5"}]}`, ≤ 5. Keeney's "why is that important", written as a direction of preference | Samples are matched by `retrieveThenVerify`; an implication is kept when 2 of 3 give the same anchor and direction. Each is stored as `I1…` with `source: "inferred"` and shown to the user for confirmation. This is the guard against a misread purpose (a small shop: minimum order `low`) |
| T1c `requirements`, `tensions`, `consumes` (fast, 3 votes each; purpose-structure, 2026-11-16) | `requirements`: punctuation pieces `S1…` → `{"groups":[["S1","S2"],["S3"]]}`. `tensions`: requirements → `{"pairs":[["C1","C3"]]}`, pairs that pull against each other, whatever the two qualities; an id twice when both sides are inside one requirement. `consumes`: purpose, requirements → `{"consumes":true\|false}`, whether the result is something the asker obtains or uses | Requirements are the voted groups (no majority: the punctuation split, logged). A pair is kept when 2 votes name it. Consumes yes or undecided adds the value side and the total-cost side. Cue words are not used |

### Stage 2 · Decomposition (Goal-Question-Metric, Basili; KAOS AND/OR refinement, van Lamsweerde) — `src/research/purpose.mjs`

| Task | Contract | Code verifies or computes |
|---|---|---|
| T2a `goals` (deep, 1 call) | Clauses, hints, purpose `P`, implications, notes (`N` id, label, quote ≤ 160 characters, ≤ 14) → `{"goals":[{"goal":"≤ 12 words","anchor":"C3"\|"H1"\|"P"\|"I2","notes":["N2"]}]}`, ≤ 8 | Ids must exist |
| T2b `refine` (deep, 1 call per goal) | One goal, its anchor text, its notes → `{"refine":"AND"\|"OR","questions":[{"q":"…","checker":"page"\|"code"\|"consensus"\|"statistic"\|"official","threshold":{"op":"<="\|">="\|"<"\|">","value":0,"unit":"…"}\|null,"note":"N2"\|null}],"obstacles":[{"obstacle":"…","checker":"…","threshold":…}]}`, ≤ 3 questions, ≤ 2 obstacles | GQM leaf rule: each question has exactly one checker. A goal with no obstacle is asked once more, then stored with `obstacles: "missing"` and shown |
| T2c `trace` (fast, 3 votes per goal; LiSSA, Fuchß et al. ICSE 2025) | The goal and lettered candidates: its claimed anchor plus the 3 anchors the embedder ranks nearest, shuffled per vote, and `N none` → `{"anchor":"A"…"D"\|"N","relation":"S"\|"R"\|"X"}`: S serves it, R only restates it, X contradicts it | Majority S: `state: "kept"` with `trace`. R: dropped as a restated clause. X: `state: "conflict"`, shown with the anchor it contradicts. N or no majority: `state: "proposed"`. Proposed and conflict goals are not researched until the user decides. This removes scope creep (financing, marketing, certification) and catches the reversed direction (large capacity against `I: minimum order low`) |
| T2d `critique` (deep, 1 call; Simon & Siebert, Decision Analysis 2025) | The tree as ids and one line each → `{"ops":[{"op":"merge","a":"G2","b":"G5"}\|{"op":"drop","id":"G4","reason":"A"\|"B"\|"C"}\|{"op":"add","goal":"…","anchor":"…"}\|{"op":"checker","id":"Q3","checker":"…"}]}`. The critique returns **operations**, never a rewritten tree | `applyOps`: a drop of a mandatory node is refused and logged; a drop that leaves a clause with no goal moves the clause to "not modelled" instead of hiding it; a merge is applied only when T2e says the two goals mean the same; an add goes through T2b and T2c |
| T2e `same-goal` (fast, 2 votes, third on a split; MultiClaimNet, arXiv 2503.22280) | Two goals → `{"same":"A"\|"B"}` (A one objective, B two) | Run for each goal against its 2 nearest neighbours by embedding rank and for every critique merge. Merges duplicates (the scenic goal stated twice) |

**Numbers (`thresholdsOf`).** A threshold lives only in the structured `threshold` field. Code compares its value with the numbers in the question and hints: equal → `source: "asked"`; else equal to a number in the quote of the cited note → `source: "sourced"` with the note's URL; else `source: "assumption"`. Any other digit run in `goal`, `q` or `obstacle` text that is in neither the user's words nor the field is recorded as `inventedNumber` on that node. Code enforces it before that (`strayNumbers`, `moveNumbers`): in `draftGoals`, `refineGoal` and the critique's `add`, a text holding a number that is in neither the user's words (question, hints, earlier answers), the quote of a cited note nor the node's own `threshold` is invalid and the model is asked once more to move it into `threshold`; each number still there goes to one closed vote of 3 (`number-kind`, fast, the sentence with the number marked): A a quantity used as a limit, target or amount, B part of a name, model, code, standard or identifier, C a date or year. Only A is taken out of the text by code and, when the node has no threshold, stored as one with `source: "assumption"`, `moved: true` and no operator; B and C stay in the text (`keptNumber`) and are not counted as invented; with no majority the text is left and `inventedNumber` records it. A number written with thousands separators is one number. An assumption is never a hard check: it runs as "asked but no limit stated" (the existing `noLimit` behaviour) until the user confirms the number.

**Protected nodes (purpose-structure, 2026-11-16; replaces `ensureAskedConflict` and the five mechanisms).** Three kinds of goal are protected (the critique cannot drop, merge or re-check them). (1) A **tension** goal per voted pair (`ensureTensions`, runs after every critique): its text is built from the two requirement texts; its hypotheses are explanations retrieved from the scoping notes, each with the id of a note it was shown and one test question (`explainTensions`), plus the single method alternative "the combination does not hold here" (Heuer ACH); fewer than 2 cited explanations is an open entry "research gap". (2) and (3), only when the `consumes` vote says yes or is undecided: the **value side** "What the result must do for the purpose" (EN 12973:2020, function analysis by how and why) and the **cost side** "Total cost to obtain and use it", refined into the three phases of total cost of ownership (Ellram 1993, 1995: pre-transaction, transaction, post-transaction); code sets the checker of a cost question: `code` for what is paid for an item, `consensus`, `page` or `official` for any other cost. Their obstacles are soft unless a vote traces them to the asker's words. The value-for-cost ratio is computed by code (`valueForCost`). `purpose.json` holds only the Admiralty scales. A goal that restates its clause (relation R) is kept and refined; only a question that restates is dropped (`measurableQuestions`). The tree stage budget is 12 calls a goal, at least 60 (`treeCap`).

**Stored:** `project.purposeTree = { version, purpose, implications, consumes:{value, decided, votes}, tensions:{pairs, decided, votes}, goals:[{id, goal, state, trace, protected, role, restates, refine, questions, obstacles, hypotheses}], notModelled:[{id, kind, text, dismissedAt?}], unrefined, valueForCost, thresholds, ops:{applied, refused}, confirmedAt }`.

**Coverage invariant (scoping-coverage, 2026-11-16).** Every requirement (clause anchor `C…`) is covered by a kept goal or listed in `notModelled`. Covered means: a goal in state `kept` with at least one question, which the trace vote put on that requirement, directly or through an implication that two samples agreed on for that requirement (`coveredAnchors`); a goal merged away leaves its requirement with the goal that absorbed it. A requirement whose own goal could not be refined is not covered through an implication. Each `notModelled` entry is an open entry: `confirmTree` refuses while one is not dismissed (`dismissNotModelled`), and `needsConfirmation` stays true even when `confirmedAt` is set. Hints (`H…`) are grouped by meaning with the same split and complete-link consensus as the question's pieces (`groupedPieces`, piece ids `T…`, stored in `requirements.hints`), so one hint that lists examples is one hint anchor; the invariant stays on clause anchors.

**Screening subject (2026-11-16).** A source is judged against what the requirements mean, not the kind word: `screeningSubject` gives `<kind>, as asked: <requirement texts>` (`askedSubject`, clause anchors only, at most 400 characters) to `source-relevance`, `source-role` and the second judgement; when the candidate table gives subject labels, `<kind> (any of: <labels>)` is kept. `drawRequirements` draws the requirements and the purpose once, before scoping, and `buildPurposeTree` takes them as `drawn`.

**Query subjects (2026-11-16).** Without a candidate table, the subject labels of `composeQueries` come from the requirements: T0f `requirement-subjects` (deep, 1 call per research) takes the clause anchors and the languages → `{"subjects":[{"anchor":"C1","phrase":"≤ 6 words","translations":[{"lang","phrase"}]}]}`. Code keeps a phrase only when every word stands in the requirements and at least one in its own requirement (one repeat with the stray words named), and a translation only when the embedder ranks it nearest to its own phrase among the phrases of this research; a translation that cannot be checked (one phrase only, or no embedder) is not used and the checked phrase serves that language. The kind label is used only when the call fails or no phrase passes (logged). Stored: `scoping.subjects`, `scoping.subjectsFrom` (`table`, `requirements` or `kind`), `scoping.askedSubjects = { subjects:[{anchor, label, translations}], rejected:[{anchor, phrase, lang?, reason}] }`.

**How the user confirms.** `buildTree` ends in phase `tree-ready` as today. `run()` pauses in the new phase `needs-confirmation` while `purposeTree.confirmedAt` is unset and any goal is `proposed` or `conflict`, any threshold is an `assumption`, or any implication is `inferred`. The log line and the tree view list each open entry with its reason. The user presses **Confirm tree** (accept or drop per entry, edit a number); `engine.confirmTree(id, { accept, drop, thresholds })` is the only writer of `confirmedAt`. No chat and no model can call it (CONCEPT: nothing runs without a button). Confirmed goals become tree nodes and checklist items in §4.

### Stage 3 · Obstacles (KAOS obstacle analysis) — in T2b, enforced in `purpose.mjs`

An obstacle with checker `page` becomes a checklist item phrased as its absence. It is hard (a "no" is a veto in `verdict.mjs`, ELECTRE TRI) only when it traces to a clause or hint the user wrote, or the user marks it hard when confirming the tree; otherwise it is soft and only orders items. No rule of the engine makes any goal or obstacle hard for every research. An obstacle with any other checker is evidence for stage 4. Obstacles are protected nodes for `applyOps` (the critique cannot delete them; the user can).

### Stage 4 · Evidence (Admiralty code / STANAG 2511; Heuer ACH; TruthFinder) — `src/research/facts.mjs`, `src/research/ach.mjs`

Evidence is gathered per **subject group** (items sharing the values of `scoping.levels`), not per item, and kept 30 days like `groupFacts`.

| Task | Contract | Code verifies or computes |
|---|---|---|
| T4a `identity` (fast, 1 call per item page) | Levels `L1…`, sentence block → `{"fields":{"L1":{"value":"…","span":"S3"}\|null}}` | A field without a real span id is null. The subject key is the ordered field values |
| T4b `facts` (fast, 1 call per kept source; sources found and screened as in stage 0 with the subject group as subject) | Questions of the tree as `Q` ids with one line each, sentence block → `{"facts":[{"spans":["S7"],"for":"Q3","direction":"+"\|"-"\|"0","scope":"A"\|"B"\|"C"}]}`, ≤ 6. scope: A the type in general, B one single unit, C a market figure (price, trend) | The claim is the quote built from the ids. Facts are tagged to question ids, so no aspect list exists in code. Scope B never becomes a type fact. Scope C never enters valuation or ACH: prices come only from the research's own comparables (Geerts ECML-PKDD 2025; LocationReasoner ICLR 2026) |
| T4c `subject-match` (fast, 3 votes per fact; Peeters, Steiner & Bizer EDBT 2025; ComEM, COLING 2025: select from a list) | The fact's quote and the item's subject ladder as options: A exactly this variant, B this model in every variant, C the wider class, D a different variant or model, E one single unit, U cannot tell → `{"applies":"A"…"U"}` | Counts for the group only on a majority of A, B or C; the level is stored. D, E, U or no majority: stored as `notApplicable` with the tally. Cached per (fact, subject key) |
| T4d `claim-pair` (fast, 2 votes, third on a split; Kazemi et al. ACL 2021; MiniCheck, Tang et al. EMNLP 2024) | Two quotes with the same `for` id from different hosts (each fact against its 3 nearest by embedding rank) → `{"relation":"A"\|"B"\|"C"}`: A same claim and agree, B same claim and contradict, C different claims | Union-find clusters over A and B edges; a split is C |
| T4e `source-method` (fast, 1 call per new host) | 8 best sentences of the source → `{"method":"A"…"F","span":"S<n>"}`: A measured data with a stated sample, B a named test, C editorial, D user reports, E the seller's own statement, F cannot tell | Stored per host with its quote. A method-E source never corroborates a claim about its own item |
| T4f `ach-row` (fast, 2 votes per row, third on a split) | One evidence row and the hypotheses `M1…` → `{"marks":{"M1":"C"\|"I"\|"N",…}}` | A cell without a majority is N |

**Admiralty arithmetic (`gradeFacts`).** Two quotes that are the same string count as one source. Per claim cluster, with `agree` and `against` the independent hosts: credibility 1 = agree ≥ 2 and against 0; 2 = agree 1 and against 0; 3 = both ≥ 1; 4 = agree 0 and against 1; 5 = agree 0 and against ≥ 2; 6 = no other host. Reliability per host comes only from its history in `data/hosts.json` (`{host: {confirmed, contradicted, total, method, quote}}`, shared by all researches, updated after each grading): F below 3 judged facts, then A to E by the share confirmed (≥ 0.9, 0.75, 0.6, 0.4). The model is never asked for a source grade.

**Priced-in check (`pricedIn`, code only).** For an item, its comparables are the kept candidate rows with the same subject key at the finest level that has ≥ 5 rows; the result is `below`, `within` or `above` the median ± 2.5 × 1.4826 × MAD of log prices (the `lowPriceCut` statistic, both sides), or `unknown`. It is one evidence row of the matrix.

**ACH (`diagnosticRows`, kept from the draft).** Rows: identity fields, the priced-in row, and applicable facts with credibility ≤ 3. Code drops a row with the same mark for every hypothesis, ranks hypotheses by fewest inconsistencies (ties by the credibility-weighted count), and lists as `needed` the conflict-goal questions with no row. **Stored:** `project.evidence = { groups:{<subject key>:{facts, clusters, at}}, items:{<url>:{identity, pricedIn, matrix:{kept, dropped, ranking, needed}}} }`.

### Stage 5 · Verdict — `src/research/verdict.mjs` stays the only owner

Tiers and their rules are unchanged. What feeds them changes (§4): a yes or no without a quote is unknown; the kind is a selection, not a yes/no; an item priced far below its comparables cannot be confirmed. In a later pull request an item whose top-ranked hypothesis is `real-defect` goes to `to-confirm` with the `needed` list; ACH never rejects an item.

## 2. The semantic layer

### 2.1 Embedder — `src/llm/embedder.mjs` (keeps the lead's routes, redesigned interface)

- **Routes:** Cloudflare Workers AI `@cf/baai/bge-m3` first (1024-d; 10,000 free neurons a day, about 9M tokens), then Gemini `gemini-embedding-001` (3072-d). Both probed live 2026-11-16; model choice per MMTEB (ICLR 2025, arXiv 2502.13595). Keys from `env` only.
- **Interface:** `rank(query, candidates, k) → { model, order:[index…] } | null` and `medoid(texts) → index | null`. **No score leaves the module**, so no caller can compare one against a threshold (the probe: a translation pair scored 0.635 on bge-m3 and 0.919 on Gemini, an unrelated pair 0.435 and 0.719). `cosine` and `nearest` become internal.
- **One model per comparison:** query and candidates are embedded in one call. When a route fails part-way, the whole set is embedded again on the next route.
- **Batching:** 50 texts a call, 2,000 characters a text, whitespace collapsed.
- **Cache:** per model, key `sha256(text)`; in memory, and on disk in `data/embeddings/<model slug>.json` (Float32 as base64, newest 20,000 vectors). A vector is only ever read under its own model.
- **Failure:** `rank` returns null when no route has keys or answers; failures are kept in `embedder.failures` and logged once per run. Callers then take the exhaustive path of §2.2. There is no lexical fallback.

### 2.2 Retrieve-then-verify — `src/research/semantic.mjs`

`retrieveThenVerify({ query, candidates, k = 3, extra = [], embedder, router, prompt, votes = 3 }) → { picked, tally, shortlist, exhaustive }`

1. Shortlist = `extra` (for example a goal's own claimed anchor) + the top `k` by `embedder.rank`. With no embedder: every candidate, in chunks of 5, each chunk judged and the chunk winners judged once more (`exhaustive: true`), capped at 25 candidates.
2. Options are lettered and shuffled per vote (position bias); a "none" option is always present.
3. `vote()` decides. No majority → `picked: null`, which every caller treats as unknown, never as a match.

This one function serves T0a, T1b, T2c, T2e, T4c and T4d (retrieval by embeddings, confirmation by a model: LiSSA; claim matching: Kazemi 2021, SemEval-2025 Task 7; selection from a list: ComEM).

### 2.3 Calls, votes and ids — `src/research/semantic.mjs`

- `ask({ router, task, tier, messages, schema })`: one `router.complete({ purpose, tier, temperature, messages })`; `schema` is a small validator (closed sets, id patterns, array lengths). An invalid reply is retried once with the validator's message, then returns null.
- `vote({ n = 3, quorum = 2, key, avoidSame = true, … })`: calls in sequence, passes the providers already used as `avoid` so votes come from different providers where the router has them, stops as soon as `quorum` answers agree (2 of 3 costs 2 calls when the first two agree). Returns `{ value, tally, replies }`.
- `router.recordOutcome({ provider, model, purpose, passed })` is called per reply: passed = valid contract and, in a vote, agreement with the majority. The router's Thompson ranking then learns which free model follows which contract.
- Purposes: `purpose-judge` (fast, temperature 0, 120 expected output tokens) and `purpose-draft` (deep, temperature 0.7 for samples, 0.2 otherwise, 900 tokens), added to `EXPECTED_OUTPUT_TOKENS` and `PURPOSE_CLASS`.

### 2.4 Sentence ids — `src/research/spans.mjs`

`sentenceSpans(text, { limit })`, `spansBlock(spans, maxChars)`, `quoteFromSpans(ids, spans)` move here from the draft unchanged in behaviour (ids `S1…`, a long sentence cut at 320 characters, an invented id gives an empty quote). `pickSpans(spans, query, embedder, k)` returns the `k` best sentences in page order, or the page opening when the embedder is unavailable.

### 2.5 Budget on free quotas — `CallBudget` in `semantic.mjs`

| Stage | Calls (typical → cap) | Tier |
|---|---|---|
| 0 scoping | 20 + 5 a source × 12 = 80 (`scopingCap`: one judgement, up to 3 role votes, one set of notes a source; the extra round only uses what is left) | 5 deep, rest fast |
| 1 purpose | 3 + 3 + 2 = 8 → 12 | 6 deep |
| 2 tree | 1 + 8 + 20 + 1 + 12 = 42 → 60 | 10 deep |
| 4 evidence, per subject group | 8 + 8 + 36 + 36 + 6 + 28 = 122 → 200 | fast |
| Page judge, per item | 1 kind + ⌈questions ÷ 4⌉ | fast |

A stage that reaches its cap stops; what was not judged is stored as unknown or `notApplicable`, never as a pass, and the log says how many. Subject groups per run: the 5 largest. Embeddings: at most 2,000 texts a research, well inside one day's free allowance on either route. The ban (R7): `FRL_BANNED_FAMILIES` (comma-separated, read from the environment) is filtered in `ModelRouter.available` with the existing `familyOf`; the family name stays out of `src/`.

## 3. The ten failures and what enforces each fix

| # | Failure in the simulation | Mechanism | Method and source | Where |
|---|---|---|---|---|
| 1 | Generic English scoping queries, off-market junk (car: 1 of 8 on market) | Queries composed by code from real subject labels and per-language aspect phrases; each source kept only on a grounded about/market judgement | STORM (Shao 2024); Corrective RAG (Yan 2024); MiniCheck | `scoping.mjs` `composeQueries`, `screenSources` (T0b, T0c) |
| 2 | Critique deleted "why still cheap" (3 of 3); obstacles removable | Critique returns operations; drops of mandatory nodes refused; `ensureMandatory` re-inserts with the mechanisms of `purpose.json`; whether it applies is voted (T1c) | Simon & Siebert 2025; KAOS; Capozza & Helsley 1989, Titman 1985, Mohammad 2013, Kurlat & Stroebel 2015 | `purpose.mjs` `applyOps`, `ensureMandatory`, `conflictAsked` |
| 3 | Facts about another variant or one single unit counted as type facts | Per-fact selection on the item's subject ladder, 3 votes; single units have their own scope and option | Peeters 2025; ComEM 2025 | `facts.mjs` `matchSubject` (T4c), scope in T4b |
| 4 | Source grade taken from the model's label | Credibility from independent corroboration of semantically matched claims; reliability from the host's history; method classified with a quote | STANAG 2511; TruthFinder (Yin, Han & Yu 2008); Kazemi 2021; MultiClaimNet 2025 | `facts.mjs` `clusterClaims` (T4d), `gradeFacts`, `HostBook` |
| 5 | Non-diagnostic ACH rows kept (9 of 17) | Marks per row by vote; diagnosticity and ranking by code | Heuer 1999 | `ach.mjs` `markRows` (T4f), `diagnosticRows` |
| 6 | A Spanish price used for a Czech research | Market-figure facts excluded; price position computed from the research's own comparables | Geerts 2025; LocationReasoner 2026 | `facts.mjs` scope C; `ach.mjs` `pricedIn` |
| 7a | Invented numbers | Thresholds only in a structured field, compared with the user's numbers and the cited quote; unconfirmed assumptions never hard | Criteria grounding (PROTOCOLS 4e) | `purpose.mjs` `thresholdsOf` |
| 7b | Scope creep; purpose misread | Each goal selected against retrieved anchors with a relation; implications as confirmed directions; proposed and conflict goals wait for the user | LiSSA 2025; Keeney; Simon & Siebert 2025 | `purpose.mjs` `traceGoals` (T2c), `implications` (T1b), `engine.confirmTree` |
| 8 | Notes and facts without a quote on the page (suppliers 0 of 14) | Models pick sentence ids; code builds the quote | Span selection; CheckEval | `spans.mjs`; T0d, T4a, T4b |
| 9 | A yes or no with an empty quote was kept | Judge answers with sentence ids; a yes or no whose ids give no quote becomes unknown; stored checks migrated | Autorubric 2026 (binary + unknown) | `checklist.mjs` `applyQuoteCheck`, `judgePrompt`, `migrateChecks` |
| 10 | Winter tyres on rims at 2,000 CZK passed the kind check (median 25,000) | Kind judged as a selection among closed options; a kind "yes" on an item priced below the low cut of its comparables becomes unknown | ComEM 2025; Leys et al. 2013 (median/MAD) | `checklist.mjs` `kindCluster`, `hardenKind`; `candidates.mjs` `lowPriceCut` |

## 4. Integration with the existing engine

**`checklist.mjs`** (this pull request)
- `judgePrompt` shows the page as a sentence block and asks `{"id":"q1","answer":"yes"|"no"|"unknown","spans":["S12"]}`; at most 4 questions a call. For a page longer than the block, `pickSpans` chooses the sentences per call.
- `applyQuoteCheck(replies, spans)`: `quote = quoteFromSpans(reply.spans, spans)`; an answer other than unknown with an empty quote becomes unknown. Numeric checks keep their code-made quote and do not pass through it.
- `kindCluster(kind)` returns the cluster plus closed options: A one unit of the asked item, offered as asked; B a part or accessory of it; C several items or a list; D a wanted ad or a service; E something else; U cannot tell. The judge asks it in its own call with a sentence id; A → yes, U → unknown, others → no. For an umbrella kind the member labels are listed under A. The check id stays `kind|<question>`, so `hardIdsOf` and `kindRejected` keep working.
- `hardenKind(checks, item, { cut, median, judge, pageText, kind })`: a low price never decides the kind by itself. When `cut` is a number, `item.value < cut` and the kind answer is "yes", a second kind judgement runs as a vote of 3 (fast, the same closed options and sentence ids) whose prompt shows the item's price and the median of its comparables: A keeps the yes and its quote, B to E give no, U or no majority gives unknown with the reason "priced far below comparable items: confirm it is the item itself". Otherwise nothing changes and no call is made. `engine.checkAcceptance` passes the cut and the median of `lowPriceStats(project.candidates?.kept)` and caches the second judgement per item.
- `CHECKLIST_VERSION` 3 → 4 and the judge version joins `checklistFingerprint`, so cached judgements are not reused.
- `clusterChecklist`'s word-overlap `sameMeaning` is replaced by T2e in pull request 2, when the checklist is generated from the confirmed tree.

**`verdict.mjs`**: no rule change. `migrateChecks` output and `hardenKind` only produce more unknowns, which already mean `to-confirm`. Later: the `real-defect` reason (§1 stage 5).

**`decision.mjs`** (pull request 2): `aggregate` takes `purpose` from T1a instead of content-word overlap; `kind.terms` and `kind.not` remain retrieval hints for portal seeds and stop deciding the kind on a page; `DecisionModeler.build` stores `purposeTree` questions with checker `page` as the checklist (source `tree`), `DECISION_MODEL_VERSION` 4 → 5.

**`engine.mjs`** (pull request 2, except `checkAcceptance` now): `studyDomain` calls `scoping.run` and keeps `domainUnderstanding` only as the readiness gate; `decompose` builds `purposeTree` first and gives the confirmed goals to `decomposePrompt`; `run` gains the `needs-confirmation` pause and `confirmTree`; `gatherGroupKnowledge` is replaced by stage 4 (`verifiedGroupFacts` retired); `gateOnKind` and `onConceptOnly` use T0c instead of `mentionsPhrase` and `topicCoverage`.

**What stays:** the listings-first order of PROTOCOLS 4m, the candidate table, valuation (7c), the external verifier, the verdict tiers, `DeeperReader` (it calls the same judge), the router.

**Migration of stored projects.** `migrateChecks(project)` runs in `reground`: every stored non-numeric check with yes or no and an empty quote becomes unknown, then `recomputeAcceptanceValidity` runs; the number changed is logged. `checkCache` entries miss by fingerprint and are judged again within `JUDGE_PAGE_BUDGET`. Projects without `purposeTree` keep running on their stored tree; the new stages run on a new research or after **re-decompose**. Witness before deploy (S7): `node scripts/dryrun.mjs` on 0c750f, b2f5b7 and b7772e, reading every tier change.

## 5. Rollout

| Pull request | Lands | Used by |
|---|---|---|
| **1 (this)** | `src/llm/embedder.mjs`, `src/research/semantic.mjs`, `spans.mjs`, `scoping.mjs`, `purpose.mjs` (rewritten), `purpose.json` (mechanisms and Admiralty scales, no cue lists), `facts.mjs`, `ach.mjs`; `checklist.mjs` changes of §4; `engine.checkAcceptance` (`hardenKind`, `migrateChecks` in `reground`); router purposes and `FRL_BANNED_FAMILIES`; `scripts/purpose-replay.mjs`; tests; lessons F35 to F38 | The engine uses the judge, the kind hardening and the migration. The replay uses every other module end to end. The rejected draft's `conflictCues`, `words`, `phraseIn`, `contentStems`, `shared`, `traceGoals` by overlap, `subjectTokens`, `sameSubject`, `onSubject` and `screenSources` are deleted |
| 2 | Engine wiring of stages 0 to 3, `confirmTree` with its button and tree view, checklist from the tree, `decision.mjs` changes, PROTOCOLS and CONCEPT text, concept-audit check for "a mandatory node is missing" | Every new research |
| 3 | Stage 4 in the run (per subject group), `data/hosts.json` in the app, evidence and ACH on the Results tab, the `real-defect` reason in `verdict.mjs` | Every list research |
| 4 | Remaining lexical meaning rules found while reading (`domain.mjs` overlap and stop words, `concept.mjs mentionsPhrase` support counts, `acceptance.mjs` host and title patterns that name sites) moved onto `retrieveThenVerify` | Existing researches, after a witness run |

Nothing in pull request 1 is unreachable: a module is imported by the engine or by the replay, and the replay is the merge gate.

## 6. The replay — `scripts/purpose-replay.mjs`

`node scripts/purpose-replay.mjs <car|suppliers|plots|all> --out <dir outside the repo> [--projects <dir>]`

- Builds `new App({ dataDir })` on a scratch data folder, `await app.refreshProviders()`, uses `app.router`, `app.search` and `new Embedder({ env: process.env })`. It refuses an `--out` inside the repo and sets nothing but what the environment already holds.
- The three questions are an argument file next to the script (`scripts/purpose-replay.questions.json`), not engine code. With `--projects` it reads the stored research (candidate rows for comparables and subject groups); without it, the car research takes its comparables, its confirmed item, the tyres-on-rims item and the stored checks from `tests/fixtures/verdict-0c750f.json` (the stored projects are not on every computer).
- Runs stages 0 to 2 for all three, once each, and stage 4 for the car research, auto-accepting nothing: proposed, conflict and assumption entries are reported as open.
- Writes `<mode>-<stage>.json` in the layout of `data/handoff/sim/sim-out`, the model-call ledger, and prints one table with the baseline next to the new value.

| Metric (computed by the script) | Baseline car / suppliers / plots | Target before merge |
|---|---|---|
| Kept scoping sources judged on market or market-free, and on subject | 1 of 8 / most / mixed | 100% of kept (by construction); and ≥ 4 distinct hosts across ≥ 2 perspectives per research, else the run is `needs-understanding`, reported as a fail |
| Knowledge sources dropped as off-market (`roles`) | not measured | 0, and every off-market drop carries its voted role |
| Requirements in a kept goal (`coverage`) | not measured | every requirement; a `notModelled` entry or a requirement neither covered nor listed is a fail |
| Second-opinion check: kept sources re-judged with another provider (`avoid`) that agree | not measured | ≥ 80% |
| Scoping notes with a quote on the page | 5 of 10 / 0 of 14 / 4 of 14 | 100% |
| "Why still cheap" goal present after critique, with all 5 mechanisms | removed × 3 | present with all 5 in the one run per research; guaranteed by code after every critique (`ensureMandatory`) and proven by tests |
| Numbers not in the user's words that are unlabelled | 10 % … / 30 %, 30 days, 95 % / 500 m, 3 %, 5 km | 0 unlabelled (each is `sourced` or `assumption`); `inventedNumber` in free text reported, ≤ 1 per tree |
| Goals in state `kept` without a trace | not measured | 0 |
| Known scope-creep goals (financing, marketing, certification) in state `kept` | present | 0 kept (they may appear as `proposed`); judged by the lead reading the output, since code has no word list for them |
| Purpose direction (suppliers: order size) | reversed | an implication with direction `low` on order size is listed, or the capacity goal is `conflict` or `proposed` |
| ACH rows kept that do not discriminate | 9 of 17 | 0 |
| Facts applied to the item from another variant or a single unit | SDI, 1.4 16V, one MOT record | 0 among applied; each is listed under `notApplicable` |
| Source grades taken from a model label | all | 0 (the contract has no such field) |
| Prices from another market in the matrix | 1 | 0 |
| Judge answers yes or no with an empty quote (20 stored item pages re-judged) | present | 0 |
| The tyres-on-rims item of 0c750f | kind yes | kind no or unknown; tier not `confirmed` |
| Calls to a banned family in the ledger | — | 0 |
| Calls per research | — | within the caps of §2.5 |

A target that fails is fixed in code, not in the prompt alone, and the replay is run again on all three (E9: replay first, batch the fixes).

## 7. Tests and lessons

No network in tests. `tests/helpers/fakes.ts` gains `fakeRouter(script)` (answers by task name, records calls, can return invalid ids, splits and errors) and `fakeEmbedder(order)` (a fixed ranking; `null` to simulate no route).

| Test file | Proves (each fails without the change) |
|---|---|
| `tests/llm/embedder.test.ts` | `rank` and `medoid` return no score; one model per call; a route failing mid-set re-embeds the whole set on the next route; cache keyed per model, a second model never reads the first's vector; no keys → null; batches of 50; disk cache round trip |
| `tests/research/semantic.test.ts` | Shortlist = extra + top k; options shuffled per vote and mapped back; no majority → null; early stop at quorum; `avoid` grows per vote; exhaustive path without an embedder, capped; invalid reply retried once; `recordOutcome` per reply; budget cap stops and reports |
| `tests/research/spans.test.ts` | The draft's three span tests, moved; `pickSpans` keeps page order and falls back to the opening |
| `tests/research/scoping.test.ts` | Queries are composed by code from subject labels and a phrase per market language; a missing language repeats the call; a source judged C or D, another market, or with an invented span is dropped with its reason; every note's quote is on its page; an invented sentence id drops the note |
| `tests/research/purpose.test.ts` (rewritten) | Conflict decided by votes on clause ids, with fixtures in three languages answered by the fake (no cue list in `purpose.json`: asserted); the critique's drop of the conflict goal is refused and logged; a kept goal is completed to 5 mechanisms; a goal voted N is `proposed`, X is `conflict`, R is dropped; a threshold equal to a user number is `asked`, equal to the cited quote is `sourced`, else `assumption` and not hard; a digit in free text is `inventedNumber`; a merge applies only on a same-goal vote; a clause left with no goal is listed as not modelled; purpose = medoid, no valid anchor → none |
| `tests/research/facts.test.ts` | A fact voted D or E is `notApplicable`; scope B and C never reach the matrix; identical quotes on two hosts count once; the credibility table row by row; reliability F below 3 facts, then by share; the host book is updated and never reads a model label; a method-E source does not corroborate |
| `tests/research/ach.test.ts` | The draft's diagnosticity test; a split cell is N; `pricedIn` needs 5 comparables and uses only candidate rows; `needed` lists conflict questions without a row |
| `tests/research/checklist.test.ts` (extended) | A yes with ids that give no quote is unknown; a yes with a real id keeps the sentence as quote; ≤ 4 questions a call; kind option B gives no; a kind yes below the low cut is unknown, and stays yes with no cut; the fingerprint changes with the judge version; `migrateChecks` turns stored empty-quote answers to unknown and leaves numeric checks |
| `tests/research/verdict.test.ts`, `tests/research/engine.test.ts` (extended) | With the 0c750f fixture, the item whose kind yes had an empty quote is `to-confirm`; `checkAcceptance` passes the low cut; migration runs once in `reground` and logs its count |
| `tests/llm/router.test.ts` (extended) | A provider whose model family is in `FRL_BANNED_FAMILIES` is never a candidate; an empty variable bans nothing |
| `tests/scripts/purpose-replay.test.ts` | With fakes: the script refuses an `--out` inside the repo, writes the stage files and prints every metric row; the metric functions on the stored `sim-out` files reproduce the baseline numbers (1 of 8 is judged by the fake; 5 of 10, 0 of 14, 4 of 14 and 9 of 17 by code) |
| `tests/scripts/recall.test.ts` | The id list ends `…, 'F34', 'F35', 'F36', 'F37', 'F38'` |

Lessons appended to `scripts/process-lessons.json`:

- **F35** · Meaning decided by words: the first purpose draft used cue lists, stems and token overlap for conflict, traceability, subject and relevance, and was rejected. Prevention: embeddings rank, a grounded closed-set judgement decides (`retrieveThenVerify`); the embedder returns no score; `purpose.json` holds no word list.
- **F36** · A rule a model is only told to follow is broken (conflict goal deleted 3 of 3, quotes paraphrased, non-diagnostic rows kept, grades self-assigned). Prevention: critique as operations with refusals, `ensureMandatory`, sentence ids, `diagnosticRows`, `gradeFacts`.
- **F37** · A yes or no without a quote counted, and a part priced at a twelfth of the median passed the kind check. Prevention: `applyQuoteCheck` on sentence ids, kind as a selection, `hardenKind`, `migrateChecks`.
- **F38** · Numbers, goals and a purpose direction the user never stated entered the tree unmarked. Prevention: `thresholdsOf`, `traceGoals`, implications, `confirmTree`.

## 8. Open decisions for the lead

1. `FRL_BANNED_FAMILIES` adds an environment switch to the router; the alternative is removing the DeepSeek entries from `presets.mjs`. The spec assumes the switch, set in the key store next to the keys.
2. `data/embeddings/` and `data/hosts.json` are new data files; PROTOCOLS 5b needs one row for the embedding cache (capped by count, never swept by age).
3. `clausesOf` loses its three English connectives (R4). Clause ids of stored decision models are not persisted, so nothing migrates; the witness run confirms.
4. The scope-creep metric is read by a person. A code metric would need a word list, which R1 forbids.
