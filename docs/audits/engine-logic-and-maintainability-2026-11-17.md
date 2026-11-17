# Audit B: the engine's logic, dependencies and maintainability

Date 2026-11-17. Base `main` ed481ad (#196). Unmerged branch `feat/crucial-factors` ee8e7d5 (base 3717ee1), read at `C:/Users/dijtb/frl-wt/t18-factors`. Auditor: Claude Code, read-only. No code was changed; this file is the only file written in the repository.

**How to read the evidence.** `file:line` refers to main ed481ad unless the line says "branch". "Ran" means a command was run in this session and its output read. "Read" means the code was read and the conclusion follows from it, with no run behind it. Line counts and constant counts come from scripts run over `src/` in this session.

**What could not be done.**

- No live research is on this computer (`data/projects` does not exist in this worktree), so nothing here was witnessed on live data. `node scripts/concept-audit.mjs --all` stopped with `ENOENT … data\projects` (S9 and O13 not answered; the script crashes instead of saying there is nothing to audit).
- The live replay (`scripts/purpose-replay.mjs`) was not run: it spends free model quota and the task allowed tests and read-only commands only. Every replay statement below is from reading the script.
- `npm run quality` was not run (no code changed). The 11 test files of the audited stage modules were run: `Test Files 11 passed (11) · Tests 237 passed (237)`.

## The five findings that matter most

1. **The purpose pipeline is not in the live run.** `scoping.mjs`, `purpose.mjs`, `facts.mjs`, `ach.mjs` and `embedder.mjs` are imported only by `scripts/purpose-replay.mjs` and by each other (grep over `src/`, `scripts/`, `verifier/`). A research started in the app still runs the older flow: `decision.mjs` → `domain.mjs` → `prompts.mjs decomposePrompt` → pieces → candidate table → memo → checklist judge. The live flow still decides meaning by words in at least 9 places (§7).
2. **The live checklist is where results are lost, and it has the weakest contract.** `checklistPrompt` (`checklist.mjs:220`) lets three samples mark each clause hard by cue words; one un-voted judge call can veto an item; the judge has no embedder, so on a long page it reads only the first 6,000 characters (`engine.mjs:303`, `checklist.mjs:273-282`, `spans.mjs:39`). This is the stage behind "0 of 20 confirmed · 45 rejected" on b2f5b7 (handoff §1, §3).
3. **`feat/crucial-factors` cannot load after it meets main.** Proven in a scratch copy of main with the branch's two modules and its import line: `purpose.mjs` first fails with `ReferenceError: Cannot access 'VALUE_ROLE' before initialization`, `facts.mjs` first fails with `Cannot access 'SCOPES' before initialization`. The replay script imports `facts.mjs` before `purpose.mjs`, so it would not start. Three more merge defects are in §2.4.
4. **A vote is not always more than one answer.** `vote()` counts two identical replies as a quorum whatever provider gave them (`semantic.mjs:88-107`), and `avoid` is only a preference in the router (`router.mjs:183-185`). With one free provider ready, a "2 of 3" vote is one model at temperature 0 asked twice.
5. **403 numeric constants, 39 named in any doc or spec.** The factors branch documents each of its numbers (spec §4.9); main does not. The ones that decide results without a stated basis are listed in §4.

---

## 1. Dependency map

### 1.1 Modules and stages

"Live" means reachable from `ResearchEngine.runScoped` (`engine.mjs:1774`). "Replay" means reachable only from `scripts/purpose-replay.mjs`.

| Stage | Module (lines) | Calls | Called by | Writes | Wired |
|---|---|---|---|---|---|
| Brief (code) | `brief.mjs` (332) | `acceptance.mjs` | `engine.briefOf`, `scoping.judgeSource` (`regionVerdict`), replay | `project.brief` (kind, regions, valueRange, `located`, `asksSea`, text) | Live |
| Decision model (legacy purpose, kind, criteria) | `decision.mjs` (493) | `checklist.mjs`, `concept.mjs`, `strategy.mjs`, `evidence.mjs bm25`, router | `engine.ensureDecisionModel` (5 call sites), `app.mjs` | `project.decisionModel` {purpose, value, needs, kind, criteria, noLimit, clauses, missing, checklist, subtype, calibrated}; `data/cases.json` | Live, list researches only (`engine.mjs:609` needs `itemCount`) |
| Legacy scoping 1: domain study | `domain.mjs` (360) | `concept.mjs`, router via engine | `engine.studyDomain`, `searchHubs` | `project.domain` {terms, not, where, object, ready, basis}; `project.hubSources` | Live |
| Legacy scoping 2: concept card | `concept.mjs` (188) | router via engine | `engine.validateConcept`, `validateUmbrella`, `gateOnKind` | `decisionModel.kind.validated`, `.terms`, `.not`, `.hubs`, `.members` | Live, only when `brief.located === false` |
| **Scoping (new)** | `scoping.mjs` (451) | `semantic`, `spans`, `brief`, **`purpose.mjs` constants** | replay; `facts.mjs` (constants, `hostOf`) | returns `scoping` object and pages; replay writes `<mode>-0-*.json` | **Replay only** |
| **Requirements, purpose, implications, tensions, value and cost sides, goals, trace, refine, critique** | `purpose.mjs` (944) | `semantic`, **`strategy.mjs clausesOf`** | replay; `scoping.mjs` (constants) | returns `tree` (the `purposeTree` shape); replay writes `<mode>-1-tree.json` | **Replay only**. Nothing sets `project.purposeTree` |
| **Factors** (branch) | `factors.mjs` (518), `factorstats.mjs` (277) | `facts`, `purpose`, `scoping`, `semantic`, `spans` | branch `purpose.buildPurposeTree`; branch replay | `tree.factors` {statements, items, byGoal, rounds, gaps} | **Branch, replay only** |
| Tree (legacy issue tree) | `prompts.mjs decomposePrompt`, `tree.mjs` (185), `treeaudit.mjs` (361) | router | `engine.decompose` | `project.nodes`, `decision`, `successCriteria`, `acceptance` | Live |
| Piece research | `engine.researchLeaf`, `evidence.mjs`, `verify.mjs`, `support.mjs`, `followup.mjs`, `harvest.mjs`, `itemgate.mjs` | router, search | `engine.runScoped` through `lanes.mjs` | `node.sources`, `finding`, `critique`, `verification`, `status` | Live |
| Listings and table | `sweep.mjs`, `portals.mjs`, `candidates.mjs`, `site.mjs`, `strategy.mjs`, `proposal.mjs`, `valuation.mjs`, `valuecase.mjs`, `verification.mjs` | search, sites, rates | `engine.collectCandidates` | `project.sweep`, `candidates`, `listingFacts`, `valueFacts`, `strategyCheck` | Live |
| Legacy facts | `engine.gatherGroupKnowledge`, `groupFactsPrompt`, `verifiedGroupFacts` (`engine.mjs:124-151, 1000-1039`) | router, search, `knowledgesources.json` | `engine.runScoped` | `project.groupFacts` | Live, and only does anything when `decisionModel.subtype.models` exists |
| **Facts (new), source method, claim clusters, Admiralty grades** | `facts.mjs` (266) | `semantic`, `spans`, `scoping` | replay (`carEvidence`), branch `factors.mjs` | returns evidence; `HostBook` file (replay: `<out>/hosts.json`) | **Replay only, car mode only** |
| **ACH, priced-in** | `ach.mjs` (96) | `semantic` | replay | returns matrix; replay writes `car-4-ach.json` | **Replay only, car mode only** |
| Critique (legacy, per finding) | `prompts.mjs critiquePrompt` | router | `engine.critique` | `node.critique` | Live |
| Critique (new, tree operations) | `purpose.mjs critique`, `applyOps` | `semantic` | `buildPurposeTree` | `tree.ops` | Replay only |
| Memo | `prompts.mjs synthesizePrompt`, `memocheck.mjs`, `gaps.mjs`, `result.mjs` | router | `engine.synthesize`, `planActions` | `project.report` | Live |
| Acceptance | `acceptance.mjs` (699), `grounding.mjs` | search | `engine.checkAcceptance` | `project.acceptanceResult` {items, checks, score} ; `report.deliverables` | Live |
| Checklist proposal | `checklist.mjs proposeChecklist`, `clusterChecklist` | router | `DecisionModeler.build` | `decisionModel.checklist` → `project.checklist` | Live |
| Checklist judge | `checklist.mjs ChecklistJudge`, `hardenKind` | `spans`, `semantic.vote`, router | `engine.checkAcceptance`, `DeeperReader`, replay | `item.checks`, `project.checkCache`, `project.kindRejected` | Live |
| Deeper reads | `deeper.mjs` (98) | `verdict`, judge | `engine.checkAcceptance` | mutates `item.checks`, `project.checkCache` | Live |
| Verdict | `verdict.mjs` (211) | `checklist.kindCluster` | `engine.recomputeAcceptanceValidity`, `acceptance.mjs`, `deeper.mjs`, replay | `acceptanceResult.verdict`, `validCount`, `items[].tier`, `acceptanceSummary` | Live |
| Semantic layer | `semantic.mjs` (203) | router | new stages; live only through `vote` in `judgeKindAgain` | `router.recordOutcome` | `vote`: live. `ask`, `retrieveThenVerify`, `agreeAcrossSamples`, `CallBudget`: **replay only** |
| Sentence ids | `spans.mjs` (43) | embedder (optional) | judge (live), new stages | — | Live (without an embedder) |
| Embedder | `llm/embedder.mjs` (175) | Cloudflare, Gemini HTTP | replay `main()` | `<dir>/<model>.json` | **Replay only**. `app.mjs` builds no `Embedder`; `ChecklistJudge` is built with `{ router }` only (`engine.mjs:303`) |
| Router | `llm/router.mjs` (706), `ranking.mjs`, `outcomes.mjs`, `provider.mjs`, `presets.mjs` | providers | everything | ledger, outcomes | Live |
| Improve loop | `improve.mjs` (998), `playbook.mjs`, `lessons.mjs`, `monitor.mjs` | engine | app | trials, lessons | Live |

### 1.2 Diagram

```
LIVE RUN (engine.runScoped)
question ─ brief.mjs ─┐
                      ├─ decision.mjs ── checklist.mjs (propose, cluster by word overlap)
                      │      │ purpose by word overlap + "so that"
                      ├─ domain.mjs (study) ─ hubs        ← output never reaches the tree prompt
                      ├─ prompts.decompose ─ treeaudit ─ tree.mjs
                      ├─ concept.mjs (only when no portal lists the kind)
                      ├─ sweep/portals ─ candidates ─ site/strategy/valuation ─ proposal
                      ├─ engine.gatherGroupKnowledge (legacy facts, vehicle prompt)
                      ├─ researchLeaf × pieces ─ evidence ─ verify ─ support ─ critique
                      ├─ synthesize (memo)                 ← before the verdict
                      └─ acceptance ─ ChecklistJudge ─ hardenKind ─ deeper ─ verdict.mjs
                                          └ spans.mjs, semantic.vote (kind-second only)

REPLAY ONLY (scripts/purpose-replay.mjs)
question ─ purpose.requirementsOf ─ drawPurpose
        ─ scoping.runScoping ── semantic.ask/vote ── embedder.rank
        ─ purpose.buildPurposeTree (tensions, consumes, implications, goals, trace, refine,
          value side, cost side, tension explanations, merge, critique, thresholds, coverage)
        ─ [branch] factors.establishFactors ─ factorstats
        ─ car only: facts.identify ─ facts.gatherEvidence ─ ach.pricedIn ─ ach.buildMatrix
        ─ judge re-run on 20 stored pages, hardenKind on one stored item, verdict

IMPORT EDGES THAT SHOULD NOT EXIST
scoping.mjs ─▶ purpose.mjs   (six constants, scoping.mjs:2)      stage 0 depends on stage 1
purpose.mjs ─▶ strategy.mjs  (clausesOf, purpose.mjs:2)          the engine depends on the glamping module
facts.mjs   ─▶ scoping.mjs   (BLOCK_CHARS, PAGE_CHARS, RELEVANCE_SPANS, hostOf)
verdict.mjs ◀─▶ checklist.mjs ◀─ decision.mjs ◀─ strategy.mjs ◀─ candidates.mjs ◀─ acceptance.mjs ◀─ verdict.mjs
[branch] purpose.mjs ─▶ factors.mjs ─▶ purpose.mjs, scoping.mjs, facts.mjs      a cycle, fatal after rebase
```

### 1.3 What the new stages would write, and what reads it

Nothing in `src/` reads or writes `project.purposeTree`, `project.scoping` or `project.evidence` (grep: 0 hits in `engine.mjs`, `app.mjs`, `server.mjs`). The spec's `engine.confirmTree`, the `needs-confirmation` phase, `data/hosts.json` in the app and tree-to-checklist are not built. The value-for-cost ratio (`purpose.mjs:532 valueForCost`) has no caller outside tests.

---

## 2. Algorithm sequence

### 2.1 The live run today (`engine.mjs:1774-1927`)

| # | Step | Where | Model calls |
|---|---|---|---|
| 1 | Domain study: item count from words, decision model (3 deep samples) and checklist (3 deep samples), 1 deep call for 8 queries, search 12 pages, 3 deep calls to read them in batches of 4. Pause `needs-understanding` when not ready | `:1788`, `:669-724` | about 10 deep |
| 2 | Hub search (only when no portal lists the kind): 1 deep call for queries | `:1795`, `:630` | 1 deep |
| 3 | Decompose: decision model again (cached when fresh), tree prompt, audit, one retry, decision model once more | `:1796`, `:445-491` | 1 to 2 deep |
| 4 | Re-ground stored checks, migrate old judge answers | `:1797` | 0 |
| 5 | Purpose check: rebuild the decision model with `force` when the purpose is empty. Pause `needs-purpose` | `:1798`, `:726-736` | 0 or 6 deep |
| 6 | Concept validation (only when no portal lists the kind): 1 query call, search, 3 concept-card samples. Pause `needs-concept` | `:1802`, `:790-825` | 4 deep |
| 7 | Tree repair, regrade | `:1824-1828` | 0 |
| 8 | Listings first (list researches): portal sweep by code, kind calibration (3 deep), candidate table, knowledge query plan (1 deep), group knowledge (per group 1 + up to 3 deep), listing pages read by code, value facts (3 deep), table rebuilt | `:1829-1843` | up to about 30 deep |
| 9 | Pieces in lanes: per leaf search, rank, research (fast, then deep on retry), critique, 2 support votes per claim, up to 3 attempts; roll-ups | `:1849-1881` | the bulk of a run |
| 10 | Candidate table again, with a sweep | `:1885` | 0 to 3 |
| 11 | **Memo** (1 deep call) | `:1891`, `:1353-1384` | 1 deep |
| 12 | **Acceptance**, called from inside `synthesize`: deliverables, liveness and range checks, then the checklist judge item by item until enough are confirmed or 90 pages are judged, second kind judgement on low prices, deeper reads (60 pages), verdict, invariants | `:1385`, `:1594-1720` | per item 1 + ⌈questions ÷ 4⌉ fast |
| 13 | Action plan, memo claim check, regression checks, phase `done` | `:1386`, `:1893-1906` | 0 |

### 2.2 The replay today (`scripts/purpose-replay.mjs:273-310`)

1. `drawRequirements`: split each comma piece (vote), group pieces by meaning (vote), 3 purpose samples.
2. `runScoping`: subject levels (3 deep samples plus matching votes, only with listing titles), requirement subjects (1 deep), fixed value and cost perspectives (1 deep), free perspectives (1 deep), queries by code, search per perspective, per source 1 relevance call + up to 3 role votes, one more round when fewer than 4 hosts across 2 perspectives, notes (1 call a kept source).
3. Second opinions: every kept page judged once more by another provider (outside the budget).
4. `buildPurposeTree`: tensions vote → consumes vote → 3 implication samples plus matching votes → goals (1 deep) → **per goal: trace vote, refine (1 to 3 deep), restates vote, number votes** → value side → cost side (3 deep) → tension explanations → duplicate merge (up to 6 votes a goal) → critique (1 deep) → apply operations (a merge votes again, an add traces and refines) → thresholds → coverage.
5. Car mode only: identity, a search, screening, facts, subject match, claim pairs, source method, priced-in, ACH rows; 20 stored pages re-judged; the tyres item re-checked.
6. Metric table, ledger, files in `--out`.

### 2.3 Where the order is wrong or wasteful

**Live run**

| # | Problem | Evidence | Cost or harm |
|---|---|---|---|
| L1 | The tree is built before the purpose is known to exist | `decompose` at `:1796`, `ensurePurpose` at `:1798`. `decompose` itself logs "purpose: not stated clearly — pieces must not be researched until it is" (`:486`) and continues | A paused research already has a tree built on no purpose; the tree is not rebuilt when the purpose arrives, because `decompose` runs only when `project.nodes` is empty |
| L2 | The kind is validated after the hubs are searched and the tree is built | `searchHubs` `:1795`, `decompose` `:1796`, `validateConcept` `:1802` | Hub queries and `markListingWork` use unvalidated kind words |
| L3 | The domain study's findings never reach the tree prompt | `decomposePrompt` gets `brief.text`, which holds the decision-model text, not `project.domain` (`:456`, `:521`) | About 4 deep calls gate the run and feed hub names, but the tree is written without what was learned |
| L4 | The memo is written before the verdict | `router.complete` at `:1358`, `checkAcceptance` at `:1385` | The memo model never sees which items were confirmed or rejected. Code then prefixes the verdict text (`planActions`, `:1401-1417`), so the stored memo can say one thing and its prefix another. This is failure mode B4 by construction |
| L5 | Whether the requirements can be checked on a page is learned last | The judge runs only in step 12; `verdict.vague` (a hard check unknown on half the items) is raised at `:1705` | Everything is spent before the run learns that a hard check is unanswerable. A 12-item probe after step 8 would show it before the pieces |
| L6 | The decision model is asked for from five places and rebuilt by force | Calls at `:451`, `:477`, `:673`, `:727`, `:922`; forced rebuild at `:730` | Mostly cached, but `ensurePurpose` forces 6 deep calls whenever the purpose test fails, and that test is lexical (§7 U1): a question not written in English fails it every time |
| L7 | Five stages each learn the subject from the web with their own query-writing contract | `studyDomain`, `searchHubs`, `validateConcept`, `planKnowledgeQueries`, `gatherGroupKnowledge` | Five prompts, five searches, five formats, none with sentence ids. `scoping.mjs` was written to replace them and replaces none |
| L8 | The judge asks the kind question last | `checklist.mjs:367` after the question loop `:356-365` | A page that is not the item still costs ⌈questions ÷ 4⌉ calls. Kind first, stop on "no" |
| L9 | A hard "no" comes from one call with no second opinion; only a low-priced kind "yes" gets a vote | `ChecklistJudge.complete` `:290-296`; `judgeKindAgain` `:310-324` | The vote protects the cheap direction (a wrong yes on a tyre set) and not the expensive one (a wrong no on a real supplier) |
| L10 | Judge calls teach the router nothing | No `recordOutcome` in `ChecklistJudge`; purpose `checklist` has no entry in `PURPOSE_CLASS` (`ranking.mjs:209-213`) or `EXPECTED_OUTPUT_TOKENS` (`router.mjs:22`) | The most numerous call of a list research is routed without learning which model follows the contract |
| L11 | Deeper reads can only turn unknown into yes, from another page of the same site, picked by English keyword match | `deeper.mjs:4-6, 18-29, 87-93` | A "yes" found on a general page of the host confirms a hard check of one item; a "no" there is ignored. Asymmetric evidence, and R1 broken |

**Replay (the new pipeline)**

| # | Problem | Evidence | Cost |
|---|---|---|---|
| R1 | Goals are refined before duplicates are merged and before the critique drops any | `traceAndRefine` `purpose.mjs:919-923`; `mergeDuplicates` `:927`; `critique`/`applyOps` `:928-930` | Refining is the dearest step (1 to 3 deep calls plus 1 to 2 votes a goal, `refineGoal :439-473`). Every merged or dropped goal wastes it. The suppliers replay hit the tree cap 90 of 90 (handoff §2a) |
| R2 | `consumes` is voted after scoping, but scoping always spends a deep call and half of the first query turns on the value and cost views | `scoping.mjs:396`; `purpose.mjs:911` | For a question whose result consumes nothing (the library and trail counter-examples) the cost view is searched and then unused |
| R3 | Tensions are voted after scoping, and their explanations may come only from scoping notes | `tensionsAsked` at `purpose.mjs:908`; `explainTension :320` reads `notes` only | No scoping query is ever aimed at a tension, so "research gap" is the likely result by construction. Vote tensions with the requirements and give each pair a perspective |
| R4 | The role of a source is voted even when it cannot change the outcome | `relevanceReason` reads the role only when `market` is C (`scoping.mjs:332-338`); `screenSources :354` votes it for every on-subject source | Up to 3 fast calls a source, wasted on every source judged market A or B |
| R5 | The same pair of goals is voted "same objective" twice | `mergeDuplicates :625`, then `applyOps` merge `:729` calls `sameGoal` again | 2 to 3 calls per critique merge |
| R6 | Subject levels are sampled and matched, then label nothing | No candidate row carries `subject` (grep of `candidates.mjs`, `valuation.mjs`, `sweep.mjs`: 0), so `subjectLabels` (`scoping.mjs:152-165`) always returns the kind | 3 deep calls plus up to 3 votes a level, used only by `identify` in car mode. `pricedIn` therefore always compares against every row (depth 0) |
| R7 | Obstacles of ordinary goals are never classed hard or soft | `softObstacles` is called for the value side (`:496`) and the cost side (`:529`) only | The hardness rule of stage 3 is not applied where most obstacles are |
| R8 | The value and cost perspectives and the free perspectives are two deep calls with the same input and output shape | `fixedPerspectives :102`, `perspectives :122` | One call |
| R9 | The embedding allowance is per process, and a long page uses hundreds of texts | `EMBED_TEXTS_PER_RUN = 2000` counts in one `Embedder` built once for all modes (`purpose-replay.mjs:324`); `judgeSource` ranks every sentence of a 40,000-character page (`scoping.mjs:298-299`) | In `all` mode later researches can run with no embeddings: page openings instead of ranked sentences, and the exhaustive vote path. The file cache is rewritten whole after each new batch (`embedder.mjs:95-101`) |
| R10 | A piece can be split once only, and only commas and semicolons cut a question | `clausesOf` (`strategy.mjs:156-158`); `splitPiece` returns at most two parts (`purpose.mjs:97-98`) | A question written as sentences is one clause; a sentence with three requirements becomes two |

### 2.4 The factors branch, as it would merge today

| # | Defect | Evidence |
|---|---|---|
| F1 | **Import cycle that fails on load after rebase.** Branch `purpose.mjs` imports `factors.mjs`; `factors.mjs` imports `facts.mjs`, `scoping.mjs`, `purpose.mjs`; main's `scoping.mjs` reads `purpose.mjs` constants at module top level (`FIXED_VIEWS`, `:30-33`), and `factors.mjs` reads `facts.mjs SCOPES` at top level (`CONTRACTS`, branch `:36-37`) | Ran, in a scratch copy of main with the branch's two modules, its import line and its four exports: entry `purpose.mjs` → `ReferenceError: Cannot access 'VALUE_ROLE' before initialization`; entry `facts.mjs` → `Cannot access 'SCOPES' before initialization`; entry `scoping.mjs` or `factors.mjs` → loads. On the branch itself all five modules load, because its `scoping.mjs` predates #196 |
| F2 | The branch undoes the coverage rule of #196 | Branch `needsConfirmation` is `!tree.confirmedAt && openEntries(tree).some(blocking)`; main's is `coverageOpen(tree).length > 0 \|\| …` (`purpose.mjs:901-903`). Branch `buildPurposeTree` has no `drawn` argument (main `:905`). Both will conflict in the merge and the wrong side is easy to keep |
| F3 | The targeted search round brings back the failure #196 fixed | Branch `factors.mjs:146` calls `relevanceReason(judged.verdict)`; on main the second argument defaults to the market role (`scoping.mjs:332`), so a knowledge source about another market is dropped. Branch `:145` calls `screeningSubject(subjects, kind)` without the requirements. `sourceClass: page.sourceClass` (branch `:106`) reads a field main never sets (main calls it `role`) |
| F4 | Factors are established before goals are merged or dropped | Branch diff: `establishFactors` runs right after tracing, before `mergeDuplicates` and `critique` | The stage is about 190 calls (spec §5); the waste of R1, larger |
| F5 | A factor one host supports and one host denies is dropped, with a reason that is false | `supportOf` gives credibility 4 for one against one; `stateOf` then says "doubted: more independent sources speak against it than for it" (branch `factorstats.mjs:209`) | Rule K6 of the spec makes a contested factor the user's call |

`factorstats.mjs` is the cleanest module read in this audit: pure, seeded, no model call, every constant named and documented. Its only coupling is `credibilityOf` and `SELLER_METHOD` from `facts.mjs`.

### 2.5 The recommended order

One order for the live run and the replay. The reason is in the right column.

| # | Step | Reason |
|---|---|---|
| 1 | Brief by code (kind words, regions, limits, item count) | No model call; everything else needs it |
| 2 | Requirements: split, group; **then the three structure votes together: tensions, consumes, and the hardness of each requirement** | They need only the user's words. Scoping can then spend on what was voted (R2, R3), and hardness stops being a by-product of the checklist prompt |
| 3 | Purpose (3 samples, medoid). Pause here when fewer than 2 samples are valid | The pause must come before any search or tree (L1) |
| 4 | Listing sweep by code, when a portal lists the kind | No model call; gives titles and prices to everything after it |
| 5 | Scoping, once: the value and cost views only when consumes is yes or undecided, one view per voted tension, role votes only when the market letter is C | Replaces `studyDomain`, `searchHubs`, `validateConcept`, `planKnowledgeQueries`, `gatherGroupKnowledge` (L7, R4) |
| 6 | Implications → goals → trace → **merge duplicates → critique → refine** | Refine once, only what survives (R1, R5) |
| 7 | Factors for the surviving qualities, then questions from factors | The owner's key question; after step 6 for the same reason (F4) |
| 8 | Thresholds, coverage, open entries. Pause `needs-confirmation` | The user confirms before anything is researched |
| 9 | Checklist from the confirmed tree. **Probe: judge 12 items**; measure determinance and which checks pages cannot answer | A check no page states is known before the pieces are paid for (L5) |
| 10 | Pieces, only for questions whose checker is not `page` or `code` | The tree stops researching what the judge or the table already answers |
| 11 | Judge the remaining items: kind first, stop on a kind "no", a hard "no" confirmed by a second provider; then deeper reads | L8, L9 |
| 12 | Facts and ACH per subject group, only for a voted tension | They need judged items and their groups |
| 13 | Verdict → **memo** → memo claim check → action plan | The memo is written from the verdict (L4) |

---

## 3. Model task inventory

Counted from the code: **63 contracts on main** (19 on the live run, 4 live checklist contracts including `kind-second`, 9 in chats, the loop and the coder, 31 in the replay-only pipeline) and **7 more on the branch**.

### 3.1 New pipeline (through `ask` or `vote`; replay only except `kind-second`)

Input size is the cap the code applies; "—" means no cap in code. Validators are the `schema` functions; an invalid reply is retried once.

| Task | File:line | Tier | Votes or samples | Input cap | Output | Validator checks |
|---|---|---|---|---|---|---|
| `subject-levels` | `scoping.mjs:66` | deep | 3 samples at 0.7 | 20 titles × 120 chars | 2 to 5 names | count |
| `subject-levels-match` | `scoping.mjs:69` | fast | 3, quorum 2, per item | short | letter | closed set |
| `requirement-subjects` | `scoping.mjs:204` | deep | 1 | 5 clauses | phrase and translations | id; every word must stand in the requirements; a translation must rank nearest its own phrase |
| `fixed-perspectives` | `scoping.mjs:117` | deep | 1 | question, purpose | phrases per language | every language covered |
| `perspectives` | `scoping.mjs:134` | deep | 1 (2 on a thin round) | question, purpose | ≤ 4 views | every language covered |
| `source-relevance` | `scoping.mjs:312` | fast | 1 a source | 8 sentences, 4,000 chars | about, market, span | closed sets; span must be on the page |
| `source-role` | `scoping.mjs:328` | fast | 3, quorum 2 | same sentences | A or B | closed set |
| `scope-notes` | `scoping.mjs:375` | fast | 1 a kept source | 40 sentences, 4,000 chars | ≤ 4 notes of ids | ids must be on the page |
| `requirement-split` | `purpose.mjs:96` | fast | 3, quorum 2, per piece of ≥ 3 words | one piece | boolean and a copied start | the copy must be found at a word boundary |
| `requirements` | `purpose.mjs:118` | fast | 3; grouping by complete link over the replies | all pieces | groups of ids | every id exactly once |
| `purpose` | `purpose.mjs:210` | deep | 3 samples; medoid | clauses, hints | who, outcome, why, anchors | an anchor id must exist |
| `implications` | `purpose.mjs:232` | deep | 3 samples | purpose, clauses | ≤ 5 of attribute, direction, anchor | closed direction, real anchor |
| `implications-match` | `purpose.mjs:235` | fast | 3, quorum 2, per item | short | letter | closed set |
| `consumes` | `purpose.mjs:245` | fast | 3, quorum 2 | purpose, clauses | boolean | type |
| `tensions` | `purpose.mjs:268` | fast | 3; a pair needs 2 | clauses | pairs of ids | ids |
| `tension-explain` | `purpose.mjs:339` | deep | 1 a tension | ≤ 14 notes × 160 chars | ≤ 4 explanations with note ids and a test | note ids; no unstated number |
| `goals` | `purpose.mjs:385` | deep | 1 | clauses, purpose, implications, ≤ 14 notes | ≤ 8 goals | ids; no unstated number |
| `trace` | `purpose.mjs:575` | fast | 3, quorum 2, a goal | goal and ≤ 4 options | letter and S, R or X | closed sets |
| `refine` | `purpose.mjs:456` | deep | 1 to 3 a goal | goal, its notes | AND or OR, ≤ 3 questions, ≤ 2 obstacles | one checker each; no unstated number |
| `restates` | `purpose.mjs:433` | fast | 3; a letter needs 2 | goal, ≤ 8 questions | letters | closed set |
| `obstacle-stated` | `purpose.mjs:484` | fast | 3, quorum 2, per obstacle of the two sides | obstacle and ≤ 3 statements | letter | closed set |
| `cost-phase` | `purpose.mjs:513` | deep | 1 × 3 phases | purpose, clauses, ≤ 14 notes | ≤ 2 questions, ≤ 1 obstacle | checker rule by `paid` letter |
| `same-goal` | `purpose.mjs:605, 625` | fast | 3, quorum 2, per pair | two goals | A or B | closed set |
| `critique` | `purpose.mjs:700` | deep | 1 | whole tree as lines | ≤ 12 operations | ids exist; closed operation set |
| `number-kind` | `purpose.mjs:790` | fast | 3, quorum 2, per stray number | one sentence | A, B or C | closed set |
| `identity` | `facts.mjs:32` | fast | 1 an item page | 40 sentences | value and span per level | span must be on the page |
| `facts` | `facts.mjs:54` | fast | 1 a source | questions and 40 sentences | ≤ 6 of ids, question id, direction, scope | all four closed |
| `subject-match` | `facts.mjs:87` | fast | 3, quorum 2, a fact | quote and 5 fixed options | letter | closed set |
| `claim-pair` | `facts.mjs:112` | fast | 3, quorum 2, a pair | two quotes | A, B or C | closed set |
| `source-method` | `facts.mjs:206` | fast | 1 a new host | 8 sentences | letter and span | span on the page, else F |
| `ach-row` | `ach.mjs:53` | fast | 3; per cell 2 | one row, hypotheses | a mark per hypothesis | every id marked |
| `kind-second` (**live**) | `checklist.mjs:322` | fast | 3, quorum 2 | 6,000 chars | letter and span | letter; span on the page |

Branch only (`factors.mjs`, `CONTRACTS :36-44`): `factor-statements` (fast, 1 a page and 4 qualities), `factor-aspects` (deep, 1 a thin quality), `same-factor` (fast, 3 votes a statement), `factor-name` (deep, 1 a factor), `factor-measure` (fast, 3 votes, only with a table), `factor-question` (deep, 1 to 2 a factor), `factor-direction` (fast, 3 votes, only for a number with no threshold).

### 3.2 Live contracts (direct `router.complete`; no `ask`, mostly no validator)

| Task | File:line | Tier | Samples | Input | Output | Checked by |
|---|---|---|---|---|---|---|
| `decision-model` | `decision.mjs:259, 462` | deep | 3 at 0.7 | question, hints, 2 example cases | concept, purpose, value, needs, kind with words in several languages, criteria, unmodelled: **seven judgements in one call** | `normalizeSample`; `aggregate` by majority; limit quote must be in the user's words |
| `checklist` (propose) | `checklist.mjs:67, 220` | deep | 3 at 0.7 | question, hints | ≤ 12 items with `hard` and `numeric` | `clusterChecklist`: Jaccard ≥ 0.3 on English content words |
| `checklist` (judge) | `checklist.mjs:292, 374` | fast | 1 | 6,000 chars, 4 questions | answer and ids per question | `applyQuoteCheck` |
| `checklist` (kind) | `checklist.mjs:303, 382` | fast | 1 | 6,000 chars | letter and id | quote must exist |
| domain queries | `domain.mjs:83`, `engine.mjs:680` | deep | 1 | question, purpose, hint | 6 to 8 queries | length ≥ 4 |
| domain findings | `domain.mjs:126`, `engine.mjs:688` | deep | 1 per 4 pages | 4 × 3,000 chars | statements by aspect | `mergeFindings`, `domainUnderstanding` (word overlap 0.5, 2 hosts) |
| hub queries | `domain.mjs:44`, `engine.mjs:637` | deep | 1 | terms, hubs | queries per hub | none |
| concept queries | `concept.mjs:49`, `engine.mjs:751` | deep | 1 | kind, question | queries | ≥ 3 of length ≥ 6 |
| concept card | `concept.mjs:66`, `engine.mjs:766, 806` | deep | 3 at 0.7 | pages | terms, not, hubs, members | `mergeConceptCards`, `mentionsPhrase` on 2 pages |
| kind calibration | `decision.mjs:218`, `engine.mjs:875` | deep | 3 at 0.7 | 60 titles | not, condition, upgrades, subtype, models, variants | words must occur in titles |
| listing schema | `search/schema.mjs:94`, `engine.mjs:902` | deep | 1 | 12,000 chars of HTML | selectors | `verifySchema` against the generic reader |
| group queries | `engine.mjs:124, 1017` | deep | 1 a group | group, engines, site list | 8 queries | must name the group's last word |
| group facts | `engine.mjs:133, 1026` | deep | 1 per 4 pages | 4 × 3,500 chars | ≤ 10 facts with a **written** quote | `verifiedGroupFacts`: substring match |
| query plan | `prompts.mjs:100`, `engine.mjs:1054` | deep | 1 | pieces, groups | queries per piece | names a group or shares 2 words with the piece |
| value facts | `valuecase.mjs:12`, `engine.mjs:1469` | deep | 3 at 0.7 | 40 ads × 600 chars | phrases for and against | phrase in ≥ 2 ads |
| decompose | `prompts.mjs:57`, `engine.mjs:454` | deep | 1 (+1 retry) | question, brief | tree and acceptance | `normalizeTree`, `auditTree`, `groundAcceptance` |
| research | `prompts.mjs:164`, `engine.mjs:1295` | fast, then deep | 1 to 3 | ≤ 2,200 chars a source | answer, claims, items, calculation | `verifyFinding` gates |
| critique (finding) | `prompts.mjs:200`, `engine.mjs:1215` | fast | 1 | finding, sources | agree, severity, issues | shape only |
| support, support-second | `support.mjs:68`, `engine.mjs:1237-1239` | deep, fast | 1 each a claim | claim, quote | verdict | `supportRecord`, `termCheck` |
| rollup | `prompts.mjs:220`, `engine.mjs:1339` | fast | 1 | children | finding | `verifyFinding` |
| synthesize | `prompts.mjs:253`, `engine.mjs:1358` | deep | 1 | all nodes, shortlist | memo | `checkMemoClaims`, after the fact |

Others outside the research flow: `expand`, `suggest`, `improve`, the three chat prompts, `read-file`, the coder's two.

### 3.3 Duplicates that should be one contract

| Should be one | Today | Why |
|---|---|---|
| "Do these two short texts mean the same?" | `subject-levels-match`, `implications-match`, `same-goal`, branch `same-factor`, and the word-overlap `sameMeaning` in `clusterChecklist`, `sameMember` in `concept.mjs`, `duplicateOf` in `treeaudit.mjs` | Four prompts and three lexical rules for one judgement. `matchPrompt(what)` already takes the noun |
| "Which of these statements states this?" | `trace`, `obstacle-stated`, `subject-match`, branch `factor-measure` | All are select-from-a-list through `retrieveThenVerify`; they differ in one sentence |
| "Write search phrases for a view" | `fixed-perspectives`, `perspectives`, branch `factor-aspects`, and the live `domainQueryPrompt`, `hubQueryPrompt`, `conceptQueryPrompt`, `groupQueryPrompt`, `queryPlanPrompt` | Eight query writers. Only the three new ones leave the query composition to code |
| "Pick the sentences that say X" | `scope-notes`, `facts`, branch `factor-statements`, and the live `groupFactsPrompt`, `domainFindingsPrompt`, `valueFactsPrompt` | Six extractors; three still let the model write the quote |
| "Refine one goal into leaves" | `refine`, `cost-phase`, branch `factor-question` | Same leaf shape, same validator (`leafValidator`) |
| Purpose | `decision.mjs` purpose field and `purpose.mjs drawPurpose` | Two owners of one fact |
| Kind | `decision-model` kind, concept card, calibration, `kindCluster` | Four contracts decide what the item is |

### 3.4 Tasks code could replace

| Task | Replace with | Basis |
|---|---|---|
| `requirement-subjects` phrase | Code already accepts a phrase only when every word stands in the requirements; code can cut the phrase itself and keep the model for translations | `scoping.mjs:195-199` |
| `number-kind` C (a date or year) | A four-digit run in a plausible year range inside a date pattern is form, not meaning | spec "structural code that stays" |
| `source-role` when market is A or B | Skip: the role cannot change the result (R4) | `scoping.mjs:332-338` |
| `consumes`, `tensions`, `requirements`, the checklist proposal: on re-runs | Cache by a hash of question and hints, as `DecisionModeler.fresh` does | none of the new votes is cached |
| `factor-name` | The medoid statement's first words (already the fallback, branch `factors.mjs:227`); the name is navigation only | spec §3 |
| `same-goal` in `applyOps` | The pair set `judged` of `mergeDuplicates` (R5) | `purpose.mjs:620-627` |

### 3.5 Where a vote is wasted or false

1. **Same-provider quorum** (finding 4). `vote()` should count a reply toward the quorum only from a provider family not yet counted, and report "one judgement" when the router has one family. Today the test `avoid grows per vote` passes while the guarantee does not exist.
2. `source-role` on market A or B sources (R4).
3. `tensions` and `requirements` need two *identical whole answers* for an early stop (`key` is the full list), so on anything but a trivial question all three calls always run. The per-pair counting afterwards is right; the early stop is only luck.
4. `ach-row`: the same, per whole row of marks.
5. `subject-levels` (R6): 3 deep samples and their matching votes for labels nothing reads.
6. A split vote marks every reply as failed for the router (`semantic.mjs:105`: `passed` needs a winner). On a question that is truly ambiguous, good providers are taught they were wrong.
7. The live checklist proposal takes 3 deep samples and then groups them by word overlap; a paraphrase lands in its own group, misses the majority and is dropped. The vote is spent and then undone by the lexical rule.

---

## 4. Constants inventory

**Count (ran):** 403 numeric constants in `src/research`, `src/llm`, `src/search` and the two branch modules. **39** have their name in a doc or spec; **364** do not. The name search overstates a little (`K1`, `SAMPLES`, `MAX_STATEMENTS` of `domain.mjs` matched unrelated text) and understates a little (CONCEPT.md states some values without the name; those are marked "value in CONCEPT").

### 4.1 Stage constants of the purpose pipeline

| Constant | File | Value | Stated basis |
|---|---|---|---|
| `STAGE_CAPS` | `semantic.mjs:1` | scoping 50, purpose 48, tree 90, evidence 200 | Spec §2.5 gives a table, but with other numbers (80, 12, 60, 200). **Three of four are overwritten at run time** (`planScoping` → 80, `purposeCap`, `treeCap`), so the constant is dead for them and wrong where read |
| `SCOPING_BASE_CAP`, `SCOPING_CALLS_PER_SOURCE` | `scoping.mjs:12-13` | 20, 5 | Spec §2.5, by counting calls |
| `MAX_SOURCES`, `MAX_QUERIES` | `scoping.mjs:7-8` | 12, 12 | Spec (≤ 12 sources); no reason for 12 |
| `MIN_HOSTS`, `MIN_PERSPECTIVES` | `scoping.mjs:10-11` | 4, 2 | Handoff §3 ("≥ 4 distinct hosts"); no source for 4 |
| `MAX_NOTES_PER_SOURCE`, `NOTE_SPANS`, `RELEVANCE_SPANS` | `scoping.mjs:9, 18-19` | 4, 40, 8 | Spec states them; no basis |
| `BLOCK_CHARS`, `PAGE_CHARS` | `scoping.mjs:20-21` | 4,000, 40,000 | 4,000 is rule R2; 40,000 is the page reader's limit (CONCEPT) |
| `SUBJECT_LABELS`, `SUBJECT_CHARS`, `SUBJECT_WORDS` | `scoping.mjs:15-17` | 5, 400, 6 | Spec; no basis |
| `PURPOSE_BASE_CAP`, `PURPOSE_CALLS_PER_PIECE`, `SPLIT_MIN_WORDS` | `purpose.mjs:35-37` | 48, 3, 3 | **None.** The spec says 12 for the stage |
| `TREE_CALLS_PER_GOAL`, `TREE_MIN_CAP` | `purpose.mjs:39-40` | 12, 60 | Spec ("12 calls a goal, at least 60"), set after the suppliers replay hit 90 of 90 |
| `MAX_GOALS`, `MAX_NOTES_SHOWN`, `MAX_TENSIONS`, `MIN_EXPLANATIONS`, `MAX_EXPLANATIONS` | `purpose.mjs:25-33` | 8, 14, 3, 2, 4 | Spec states 8, 14, 2; **none for 3 and 4** |
| inline: 3 samples, 5 implications, 3 questions, 2 obstacles, 12 operations, 12 words a goal, 40 words a leaf | `purpose.mjs:209, 227, 445-446, 687, 380, 392` | — | Spec states them; **they are literals, not constants** |
| `SAMPLE_TEMPERATURE`, `DRAFT_TEMPERATURE` | `semantic.mjs:7-8` (and again `decision.mjs:13`) | 0.7, 0.2 | Spec §2.3; no basis |
| `EXHAUSTIVE_CAP`, `EXHAUSTIVE_CHUNK` | `semantic.mjs:2-3` | 25, 5 | Spec §2.2; no basis |
| `MAX_FACTS_PER_SOURCE`, `FACT_SPANS`, `NEAREST_CLAIMS` | `facts.mjs:8-11` | 6, 40, 3 | Spec; no basis |
| `MIN_HOST_HISTORY`, reliability shares 0.9, 0.75, 0.6, 0.4 | `facts.mjs:10, 160` | 3; inline | Spec states them. **STANAG 2511 defines the letters, not these shares**; they are this engine's convention and nothing says so |
| `MIN_COMPARABLES`, `PRICE_MADS`, `MAD_SCALE`, `MAX_ROW_CREDIBILITY` | `ach.mjs:5-8` | 5, 2.5, 1.4826, 3 | 2.5 and 1.4826: Leys et al. 2013 (spec §3 row 10). 5 and 3: none |
| `EMBED_BATCH`, `EMBED_TEXT_CHARS`, `EMBED_CACHE_SIZE`, `EMBED_TEXTS_PER_RUN` | `embedder.mjs:5-8` | 50, 2,000, 20,000, 2,000 | Spec §2.1 and §2.5. 2,000 texts "a research" is enforced per process (R9) |
| Branch: 13 constants in `factors.mjs`, 9 in `factorstats.mjs` | — | — | **All documented with a reason** in spec §4.9, except `NEAREST_FACTORS`, `QUESTION_STATEMENTS`, `NAME_WORDS`, `METHOD_RANKS`, `CREDIBILITY_ORDER` |

### 4.2 Live constants that decide a result

| Constant | File | Value | Stated basis |
|---|---|---|---|
| `JUDGE_PAGE_BUDGET` | `engine.mjs:267` | 90 | **None** |
| `DEEPER_PAGE_BUDGET` | `deeper.mjs:37` | 60 | Handoff §1 (#192) states it; no reason |
| `JUDGE_QUESTIONS_PER_CALL`, `JUDGE_BLOCK_CHARS`, `JUDGE_PAGE_CHARS`, `KIND_SECOND_VOTES` | `checklist.mjs:24-30` | 4, 6,000, 40,000, 3 | Spec §4 for 4 and 3. 6,000 breaks rule R2 (≤ 4,000) with no note |
| Checklist grouping: Jaccard 0.3; content word ≥ 4 letters; ≤ 12 items | `checklist.mjs:158, 164, 74` | inline | **None; and a lexical meaning rule** |
| Vague check: ≥ 5 judged, unknown on ≥ 0.5 | `verdict.mjs:106` | inline | **None** |
| `MIN_PRICE_SAMPLE`, `LOW_PRICE_MADS` | `candidates.mjs:209-211` | 20, 2.5 | Leys 2013 for 2.5; 20 none |
| `HARD_SEA_KM`, `HARD_CAMPING_MONTHS` | `candidates.mjs:212-213` | 20, 10 | **Hard constraints of one research, written in engine code** (§7 U8) |
| `MAX_ATTEMPTS`, `SUPPORT_PARALLEL` | `engine.mjs:51, 57` | 3, 3 | PROTOCOLS names `MAX_ATTEMPTS` |
| `DOMAIN_QUERIES`, `DOMAIN_SOURCES`, `DOMAIN_PAGES_PER_CALL`, `HUB_SOURCES`, `GROUP_*` (5), `QUERY_PLAN_GROUPS`, `CALIBRATION_TITLES`, `CALIBRATION_SAMPLES`, `RECALIBRATE_GROWTH` | `engine.mjs:58-61, 106-114` | 8, 12, 4, 15, 6/8/12/4/30 days, 6, 60, 3, 3 | **None** |
| `MIN_JUDGED_TEXT`; off-topic rule "≥ 2 shared words" | `engine.mjs:266, 860` | 300; inline | CONCEPT states the two-word rule; a lexical rule |
| `FACT_PAGES` | `engine.mjs:274` | 400 | **None** |
| `MAX_ITEM_CHECKS`, `INSPECT_PER_ASKED`, `MIN_LIVE_TEXT`, `KIND_STEM` | `acceptance.mjs:22-25, 594` | 100, 4.5, 200, 5 | **None** |
| `SUPPORT_HOSTS`, `OVERLAP` (domain understanding) | `domain.mjs:80-81` | 2, 0.5 | **None; lexical** |
| `CONCEPT_*`, `MIN_PAGES`, `MIN_MEMBERS`, `MAX_MEMBERS`, `UMBRELLA_*` | `concept.mjs:3-11` | 6, 10, 3, 2, 2, 16, 12, 24 | **None** |
| `UTILITY_PRIOR`, `UTILITY_WEIGHT`, `UTILITY_RATE`, `CASES_RETRIEVED` | `decision.mjs:14-18` | 0.5, 0.5, 0.3, 2 | **None** |
| `EVIDENCE_CHARS`, `PASSAGE_CHARS`, `K1`, `RRF_K` | `evidence.mjs:3-6`, `search.mjs:46` | 2,200, 320, 1.2, 60 | CONCEPT: BM25, RRF k = 60 (RAG-Fusion) |
| Valuation: `MIN_SLOPE_POINTS`, `YEAR_WINDOW`, `COMPARABLES`, `MIN_COMPARABLES`, `MISCOVERAGE`, `MIN_CALIBRATION` | `valuation.mjs:6-12, 260-261` | 30, 2, 7, 5, 0.2, 30 | AUDIT-PROTOCOL A21, A22 give the story |
| Site and climate (`site.mjs`, `cci.mjs`, `strategy.mjs`, `proposal.mjs`: about 50) | — | — | Mostly "value in CONCEPT" (Ma 2021, the Portuguese camping rule). One research type's numbers in the engine (§7) |
| Router (26 in `router.mjs`, 5 in `ranking.mjs`, 3 in `outcomes.mjs`) | — | — | 4 named in AUDIT-PROTOCOL (D9 to D13). `TIER_TIMEOUT_MS` 45/90 s, `SLOW_FACTOR` 4, `FAILURE_STREAK_BENCH` 12, `MAX_SWITCHES_PER_CALL` 3: none |
| Improve loop (16 in `improve.mjs`) | — | — | `NOISE_SIGMAS` 2, `STALL_TRIALS` 20, `PLATEAU_TRIALS` 12, `REPEAT_SIMILARITY` 0.85: none in a doc |

### 4.3 The same number defined more than once

| Number | Copies |
|---|---|
| 2.5 MAD and 1.4826 | `ach.mjs:6-7`, `candidates.mjs:210-211`, `strategy.mjs:383-384`, `valuation.mjs:11-12` |
| Grade ranks | `engine.mjs:49`, `improve.mjs:21`, `monitor.mjs:4`, `specs.mjs:3`; and as weights in `score.mjs:1`, `gaps.mjs:5`, `result.mjs:6` with different values |
| Sample temperature 0.7 | `semantic.mjs:7`, `decision.mjs:13`, literal in `checklist.mjs:67` |
| 3 samples | `decision.mjs:12`, `concept.mjs:5`, `engine.mjs:59`, literals in `purpose.mjs`, `scoping.mjs` |
| Minimum comparables 5 | `ach.mjs:5`, `valuation.mjs:7`, `strategy.mjs:379`, `valuecase.mjs:7`, branch `factorstats.mjs:6, 9` |
| Page budget 90 | `sweep.mjs:8`, `engine.mjs:267` (two different things) |
| Region to language | `prompts.mjs:6` and `knowledgesources.json regionLanguages` |

### 4.4 The ones without a basis that should get one first

`JUDGE_PAGE_BUDGET` 90, `JUDGE_BLOCK_CHARS` 6,000, the Jaccard 0.3, the vague rule (5 and 0.5), `MIN_HOSTS` 4, `PURPOSE_BASE_CAP` 48, the reliability shares, `MIN_COMPARABLES` 5 in `pricedIn`, `EMBED_TEXTS_PER_RUN` 2,000 against real page sizes, `TIER_TIMEOUT_MS`. Each decides what is confirmed, dropped or left unjudged, and none has a measurement behind it.

---

## 5. Maintainability

### 5.1 Size and complexity (ran: a script over `src/`)

130 modules, 26,081 lines, 1.3 MB. Lines are long: the count of lines understates the code.

| Module | Lines | kB | Longest line | Lines over 200 chars | Exports | Branch points |
|---|---|---|---|---|---|---|
| `engine.mjs` | 2,227 | 127 | 715 | 75 | 20 | 1,015 |
| `purpose.mjs` | 944 | 64 | 972 | 51 | 82 | 426 |
| `improve.mjs` | 998 | 50 | 334 | 21 | 49 | 404 |
| `prompts.mjs` | 550 | 43 | 1,207 | 58 | 17 | 173 |
| `strategy.mjs` | 511 | 43 | 918 | 55 | 36 | 255 |
| `router.mjs` | 706 | 34 | 361 | 9 | 34 | 300 |
| `site.mjs` | 736 | 34 | 402 | 13 | 56 | 310 |
| `decision.mjs` | 493 | 32 | **2,296** | 20 | 31 | 263 |
| `acceptance.mjs` | 699 | 31 | 590 | 12 | 21 | 310 |
| `scoping.mjs` | 451 | 28 | 552 | 20 | 45 | 183 |
| `checklist.mjs` | 390 | 20 | 1,655 | 9 | 27 | 143 |
| `facts.mjs` | 266 | 14 | 501 | 8 | 21 | 110 |
| `semantic.mjs` | 203 | 10 | 336 | 3 | 18 | 92 |
| `verdict.mjs` | 211 | 8 | 166 | 0 | 8 | 81 |
| branch `factors.mjs` | 518 | — | about 900 | — | 43 | — |
| branch `factorstats.mjs` | 277 | — | — | — | 35 | — |

### 5.2 Hotspots

1. **`ResearchEngine`** is one class of about 100 methods and 1,950 lines that owns the run order, team lanes, the tree editor, acceptance, the judge loop, domain study, concept validation, group knowledge, geocoding and the memo. `checkAcceptance` (`:1594-1720`) is 127 lines with a cache, two budgets and three early exits. `runScoped` is 150 lines. It imports 44 modules.
2. **`purpose.mjs`** holds seven stages and 82 exports: requirements, purpose, implications, tensions, the value and cost sides, goals, trace, refine, merge, critique, numbers, thresholds, coverage, confirmation. `refineGoal` (`:439-473`) has four retry paths; on the branch it gains three more.
3. **`decision.mjs:263`** is one prompt line of 2,296 characters that asks for seven judgements.
4. **`retrieveThenVerify`** takes 21 named parameters and has three modes (select, pairwise, fixed) with different return shapes (`picked` is one candidate or a list).
5. **Branch `establishFactors`** takes 16 parameters, is 80 lines, and mutates the statements it was given (`statement.factor`, `.why`, `.label`).

### 5.3 Duplicated logic

| Logic | Copies |
|---|---|
| `compare(value, op, limit)` | `checklist.mjs:174`, `decision.mjs:46`, branch `factorstats.mjs:249` |
| `MEASURES` (the table measures) | `checklist.mjs:181` and `decision.mjs:25`, **with different reads**: `coastKm` is `undefined` in one and `Infinity` in the other when the site has no sea distance, so the same row can be "unknown" for the judge and "fails" for the decision model |
| Numbers in text | `purpose.mjs:755-768` (thousands separators), `decision.mjs:53` (none), `checklist.mjs:229, 235` (digit runs). A threshold of 20 000 is one number in the tree and two in the decision model |
| Host of a URL | `scoping.mjs:35`, `search/selection.mjs`, `deeper.mjs:8` |
| Median and MAD | `ach.mjs:10`, `candidates.mjs:240`, `decision.mjs:93`, `strategy.mjs`, `valuation.mjs`, branch `factorstats.mjs:90` |
| Aspect phrases per language | `scoping.mjs:89-100` and branch `factors.mjs:117-130`, line for line |
| "Sentence block, then the shown subset" | `scoping.mjs:366-369`, `facts.mjs:22-24, 44-47`: `spans.slice(0, block.split('\n').length)` three times |
| Stop-word sets | 8 (`acceptance.mjs:115`, `domain.mjs:278`, `evidence.mjs:69`, `treeaudit.mjs:13`, `search.mjs:36`, `selection.mjs:5`, `chat/docs.mjs:7`, `coder/context.mjs:4`) and `QUESTION_SCAFFOLD` (`checklist.mjs:161`), all English |
| Leaf prompt text (the five checkers) | `purpose.mjs:327, 441, 501`, branch `factors.mjs:34` and `purpose.mjs` again |

### 5.4 Dead or unreachable code

- `scoping.mjs`, `purpose.mjs`, `facts.mjs`, `ach.mjs`, `embedder.mjs`: reachable only from a script (about 2,100 lines). Spec §5 allowed this for pull request 1; four pull requests later it is still so.
- `purpose.mjs:5 PURPOSE` (`purpose.json`): no reader in `src/` or the replay; the Admiralty labels are never shown.
- `purpose.mjs:182 anchorsOf`, `:532 valueForCost`: no caller outside tests.
- `semantic.mjs:1 STAGE_CAPS.scoping/purpose/tree`: overwritten before first use.
- `scripts/purpose-replay.mjs:21 SIM_OUT` points at `data/handoff/sim/sim-out`; that folder is not in this checkout (`data/` holds `ref/` only), so the computed baselines fall back to the hand-typed `BASELINE` strings.
- `scripts/purpose-replay.questions.json`: every entry has `guidance: ""`. Without `--projects` the replay runs with no hints, the failure the handoff named (§3: "the user's hint was lost").
- `engine.mjs:144 verifiedGroupFacts`: marked "retired" in spec §4, still live.
- `candidates.mjs:219 passesEveryHardCriterion`: to be checked by its owner; it hard-codes two limits of one research.

### 5.5 Tests

Ran: 144 test files, about 1,760 cases; 128 of 130 modules have a mirrored test (`cli.mjs` and `llm/presets.mjs` do not).

| What the tests of the new stages prove | What they cannot prove |
|---|---|
| Code logic given scripted replies: id checks, quorum arithmetic, complete-link grouping, number rules, coverage, the Admiralty table, diagnosticity. These are real tests of real logic | Any property of a prompt. `fakeRouter` answers by task name (`tests/helpers/fakes.ts:21-27`); 142 uses in the `purpose`, `scoping`, `semantic`, `facts` and `ach` tests. No test would fail if a prompt were emptied, as long as the task name stayed |
| The order and count of calls (`router.count(task)`; 57 lines read the recorded calls in four files) | That votes come from different providers: `fakeRouter` hands out `p1, p2, p3` in turn, so the same-provider quorum (finding 4) cannot show |
| `purpose-replay.test.ts`: the metric functions on fixtures | That the replay works end to end against main's import order after the factors merge (F1) |

Tests that assert only wiring: about 35 lines in `purpose.test.ts` and `scoping.test.ts` read the prompt text or the message list (a grep count, not read one by one). Those that compare wording pin the prompt, not behaviour, and break on any prompt edit.

Missing tests: `ChecklistJudge` on a page longer than one block without an embedder; a hard "no" from one call; `clusterChecklist` on two paraphrases; `DecisionModeler` purpose on a non-English question; `runScoped` order (purpose before tree); the embedder allowance across two researches.

### 5.6 Coupling

- **Check ids are strings built in six places**: `cluster.clause + '|' + ci.question` (`checklist.mjs:300, 350, 353`, `verdict.mjs:34, 37`, `deeper.mjs:33, 70`). `deeper.mjs:70` then splits the id at `|` to get words back. A question that contains `|` breaks it; changing one wording changes the id and silently empties the cache.
- **`project.checkCache` holds two shapes under one object**: `{ checks, summary, kindSecond }` under `url::fingerprint` (`engine.mjs:1647`) and a bare array under `url::checkId` (`deeper.mjs:84`). The 500-entry trim (`:1649`) deletes the oldest key of either shape.
- **`brief.located`** decides the whole flow (candidate table or pieces) and is computed from `template.itemKind`, `kind.validated` and a seed list of sites (`engine.mjs:519`, `portals.mjs:71`). Six stages branch on it (AUDIT-PROTOCOL E12 is this coupling).
- **`decisionModel.kind`** is read and rewritten by `decision.mjs`, `engine.validateConcept`, `validateUmbrella`, `calibrateKind`, `collectCandidates` (`verifyKind`), `checklist.kindCluster`, `acceptance.purposeChecks`. Twelve fields, no owner.
- Stage 0 imports stage 1 (`scoping.mjs:2`); the engine's purpose module imports the glamping strategy module for an 80-character function (`purpose.mjs:2`).

### 5.7 Naming

- Three things are called *purpose*: `decisionModel.purpose` (a sentence with "so that"), `purposeTree.purpose` (who, outcome, why), `acceptance.purposeChecks` (name lists from the question).
- Two things are called *critique*: a review of one finding (`engine.critique`) and tree operations (`purpose.critique`). Two *facts*: `groupFacts` and `facts.mjs`. Two *MEASURES*. Two *STAGE* constants with the same value in `facts.mjs` and `ach.mjs`. Two *MAX_STATEMENTS* (5 in `domain.mjs`, 12 on the branch).
- Tiers: `fits / trade-off / unverified / weak / blocked` (`strategy.mjs:378`) and `confirmed / to-confirm / rejected / not-judged` (`verdict.mjs`), both called "tier" on one item (`row.plan.tier`, `item.tier`).
- `verdict.mjs` is the only file with mixed quote styles and no long lines; it reads as written by another hand, and it is the easiest module in the engine to follow.

### 5.8 Score

| Dimension | Score (0 to 5) | Why |
|---|---|---|
| Modularity | 2 | One god class; one module with seven stages; small pure modules elsewhere |
| Coupling | 2 | String ids, shared mutable `project`, `located`, `kind` |
| Duplication | 2 | §5.3 |
| Reachability | 2 | A fifth of the research code runs only from a script |
| Tests | 3.5 | Broad, fast, mirrored; blind to prompts and to provider independence |
| Readability | 2 | 700-character lines, no comments by rule, three meanings per name |
| Universality | 1.5 | §7 |
| **Overall** | **2.2 of 5** | The new pipeline (`semantic`, `spans`, `facts`, `ach`, `verdict`, branch `factorstats`) is 3.5 to 4; the live path pulls it down |

**Top refactors**, in order: (1) wire the new pipeline and delete the five legacy scoping stages; (2) split `engine.mjs` into a run sequencer and stage modules that take and return data; (3) split `purpose.mjs` into `requirements.mjs`, `tree.mjs`-level goal building, `numbers.mjs`, `coverage.mjs`; (4) one `checks.mjs` owning check ids, the cache shape and `MEASURES`; (5) one `stats.mjs` for median, MAD, quantile, compare; (6) one contracts table (the branch's `CONTRACTS` object is the pattern) so prompts are data with a name, a tier, a size and a validator.

---

## 6. Output structure determination

### 6.1 How the shape of a result is decided today

| Part of the result | Decided by | Follows the purpose and requirements? |
|---|---|---|
| List or not | `itemCountFromWords` (`acceptance.mjs:84-99`): a number next to one of about 20 English nouns ("links", "cars", "plots", "suppliers", …) | **No.** A word list. "Zwanzig Lieferanten" or "a few good trails" is not a list |
| Kind of memo (plan, estimate, list, decision) | `questionKind` (`result.mjs:50-60`): three English regular expressions on the question | **No.** A word list |
| Memo fields | Fixed in `engine.synthesize` (`:1365-1384`): verdict, summary, key numbers, scenarios, sensitivity, risks, next steps, best estimate, options | No. The same fixed fields for every research |
| Candidate table or pieces | `brief.located` (`engine.mjs:519`): a template, or a seed list of sites | **No.** Decided by which sites the code knows |
| Candidate table columns | Fixed in `workbook.mjs:100`: about 40 columns including "glamping units", "sea km", "workable months", "campsites within 15 km", "zoning", "legal path" | **No.** A car list is exported with glamping columns |
| Ranking and the proposal | `proposal.mjs:11-18 OBJECTIVES`: criteria met, entry cost, distance to the sea, camping months, optimal climate days, things to explore | **No.** Six objectives of one research. For cars, `valuecase.mjs` has its own |
| Deliverables | `candidateDeliverables` when a table exists, else `entityDeliverables` or `collectDeliverables` (`engine.mjs:1601-1604`) | Partly: by `located` |
| Acceptance checks | The model proposes them in the decompose reply; `groundAcceptance` keeps what the user's text states (`:472`); the count check; `purposeChecks` (name lists) | Partly. Grounding is good; the proposal is a by-product of another task |
| Checklist (what makes an item valid) | `checklistPrompt` (`checklist.mjs:220`): 3 samples, each clause → a yes/no question, `hard` by cue words in the prompt ("must have, required, up to, at least, within") | **No.** Not from the purpose tree; hardness by cue words in a prompt, majority of samples. This is the handoff's "every clause and hint is a hard page question" |
| Verdict tiers | `verdict.mjs` | Yes: one owner, by code |
| Score | `scoreOf`: mean of the check values (`verdict.mjs:148`) | Mechanical; equal weight for every check |
| Report export | `report.mjs`, `workbook.mjs`: fixed sheets | No |

### 6.2 What should decide it

The purpose tree already holds what is needed; nothing reads it.

| Part | Should come from |
|---|---|
| List or not, and how many | A closed vote on the requirements (A: a set of items to choose from, B: one answer or estimate, C: a plan), with the count read by code from the clause the vote points at |
| Columns of the table | One column per tree question with checker `code` or `page`, in goal order, each with its unit; plus the item's own stated facts. No fixed column list |
| Ranking | Pareto layers over the per-goal scores (`scoreObjectives` on the branch does exactly this), inside a verdict tier |
| Hard or soft | The hardness rule applied to requirements by a vote (step 2 of §2.5) and the user's confirmation; never by the checklist prompt |
| Acceptance checks | One per requirement: its goal's questions answered on the delivered items; the coverage invariant already guarantees every requirement has a goal or is listed |
| Memo sections | One section per goal of the tree, then value for cost when both sides exist, then the open entries. The memo model words them; code fixes the list |
| Report | Rendered from the same tree: goals, questions, per-item answers with quotes |

---

## 7. Spectrum scope of each logic piece

### 7.1 Which research types each stage serves

LL = located listings (plots, cars), EL = entity lists (suppliers), KQ = knowledge questions, NV = numeric valuation, CMP = comparisons. ✓ serves, ~ partly, ✗ breaks or does nothing.

| Stage | LL | EL | KQ | NV | CMP | Where it breaks |
|---|---|---|---|---|---|---|
| Brief | ✓ | ~ | ~ | ~ | ✗ | Regions and price limits only; nothing for "A or B" |
| Decision model (live) | ✓ | ~ | ✗ | ~ | ✗ | Runs only with an item count; its measures are the glamping site measures; purpose test is English only |
| Domain study (live) | ~ | ✓ | ~ | ✗ | ✗ | Prompt is about a traded good ("how it is sourced, sorted, graded and packaged") |
| Concept card (live) | ✗ | ✓ | ✗ | ✗ | ✗ | Only when no portal lists the kind |
| Scoping (replay) | ✓ | ✓ | ✓ | ~ | ~ | Universal by design. Without a table the subject is the kind word plus requirement phrases; a comparison has two subjects and one label |
| Requirements | ✓ | ✓ | ✓ | ✓ | ~ | R10: commas only; one split a piece |
| Purpose, implications | ✓ | ✓ | ✓ | ✓ | ✓ | Universal |
| Tensions | ✓ | ✓ | ~ | ~ | ✓ | Explanations only from notes that no query aimed at (R3) |
| Value and cost sides | ✓ | ✓ | ✗ | ~ | ~ | The cost phases' examples are a purchase ("minimum order, delivery, duties, returns", `purpose.mjs:15-17`); for knowledge the consumes vote should say no |
| Goals, trace, refine, critique | ✓ | ✓ | ✓ | ✓ | ~ | The five checkers assume items with pages; a knowledge question has no item |
| Factors (branch) | ✓ | ✓ | ~ | ~ | ✓ | Effect needs ≥ 30 priced rows; with no candidates every factor stays "not yet measured" |
| Legacy tree and pieces | ~ | ~ | ✓ | ✓ | ✓ | The best fit for knowledge and estimates; it is what the engine began as |
| Sweep, candidate table | ✓ | ✗ | ✗ | ✗ | ✗ | By design |
| Site fit, strategy, proposal | plots only | ✗ | ✗ | ✗ | ✗ | One research type |
| Valuation, value case | cars only | ✗ | ✗ | ~ | ✗ | Year and mileage patterns in Czech, German, Polish |
| Legacy group knowledge | cars only | ✗ | ✗ | ✗ | ✗ | Hard-coded concept `'used-vehicle'` |
| Facts, ACH (replay) | ~ | ~ | ~ | ✗ | ✗ | Subject ladder assumes model and variant; priced-in needs prices; run for cars only |
| Checklist judge | ✓ | ✓ | ✗ | ✗ | ✗ | One item, one page. A quality that is not stated on the item's own page ("proven good quality") is always unknown |
| Deeper reads | ~ | ✓ | ✗ | ✗ | ✗ | English keyword link picking |
| Verdict | ✓ | ✓ | ✗ | ✗ | ✗ | Items only; a knowledge answer has no tiers |
| Memo | ✓ | ✓ | ✓ | ✓ | ~ | Fixed fields |
| Router, embedder, semantic layer | ✓ | ✓ | ✓ | ✓ | ✓ | Universal |

Read across: **no stage owns a knowledge question, a valuation or a comparison end to end in the new pipeline**; the legacy tree does. The new pipeline is an item-list pipeline with universal front stages.

### 7.2 Universality violations left in `src/`

**Meaning decided by words, on the live path**

| # | Where | What |
|---|---|---|
| U1 | `decision.mjs:172-182` | The purpose is the sample sharing the most ≥ 4-letter words with the question, kept only with ≥ 2 shared words **and the English words "so that"**. Spec §4 said this would be replaced in pull request 2 |
| U2 | `checklist.mjs:155-170` | Two checklist questions "mean the same" at Jaccard ≥ 0.3 over words, after removing 30 English scaffold words |
| U3 | `checklist.mjs:220` | The prompt tells the model to mark hard by cue words: "must have, required, up to, at least, within"; soft: "highest, best, prefer, ratio" |
| U4 | `deeper.mjs:4-6, 18-29` | Which linked page answers a check: any link whose text shares a ≥ 4-letter word with the check |
| U5 | `engine.mjs:860`, `evidence.mjs:69-77` | A page is off topic when it shares fewer than 2 words with the piece, behind an English stop list |
| U6 | `engine.mjs:827-847`, `acceptance.mjs:596-603`, `concept.mjs:41-47` | A page is "the asked kind" by 5-letter stems of kind words; a "near-miss kind" by phrase match |
| U7 | `engine.mjs:172-209` | `mentionsModel`, `namesGroup`, `contentWordHits`: knowledge queries kept by word hits |
| U8 | `domain.mjs:80-81, 278`, `treeaudit.mjs:9, 13` | Understanding and duplicate pieces by word overlap 0.5 and 0.6 |
| U9 | `acceptance.mjs:84`, `result.mjs:50-54` | List or not, and the kind of answer, by English word lists (§6.1) |

**Site names**

| Where | What |
|---|---|
| `portals.mjs:9-43` | pisos.com, emlakjet.com, imovirtual.com, sreality.cz, bezrealitky.cz, autoscout24.de, auto.bazos.cz with 17 car makes, otomoto.pl, autobazar.eu, willhaben.at; `CAR_SAMPLE` word list; 8 Spanish regions, 11 Turkish provinces, 10 Portuguese districts. `listedKind` (`:71`) uses this list to choose the whole flow |
| `acceptance.mjs:297-301` | alibaba.com, made-in-china.com, tradewheel.com, tradekey.com, ec21.com, globalsources.com, indiamart.com; accio.com, apparelsearch.com; yelp, tripadvisor |
| `knowledgesources.json` | 14 sites (tuv.com, adac.de, dekra.de, …) under concept `used-vehicle`; 14 car makes mapped to a language |

**Domain words and prompts**

| Where | What |
|---|---|
| `engine.mjs:128-129, 137-138` | "which engines or variants … are reliable, durable or problematic, what typically fails and at what mileage" |
| `engine.mjs:1011` | `knowledgeSourcesFor('used-vehicle')`, for every list research that has models |
| `engine.mjs:268, 977, 1498, 1504` | Twelve site measures by name; "e-bike ride from the sea"; listing facts `{ year, km, kw, engine, fuel }`; "read by code for year and mileage" |
| `decision.mjs:25-44` | `MEASURES`: 15 measures, 11 of them for a camping plot; the decision model can express nothing else |
| `decision.mjs:221` | Calibration prompt: "estate, sedan, cabriolet or van", "parts, wheels, tyres, lights, bumpers, doors, engines sold alone" |
| `decision.mjs:263` | Example in the prompt: "home improvement contractors … roofers, plumbers, electricians" |
| `decision.mjs:296, 333-348` | `MODEL_RULES` (`ebikeKm`); `REFERENCE_CASE`: the glamping question in the owner's words, with "terreno, parcela, arsa, tarla", returned by `CaseBank.all()` as an example for every research |
| `checklist.mjs:181-196, 220` | The same measures again; named in the checklist prompt |
| `domain.mjs:65-67` | "Dutch \"vintage groothandel\", German \"Vintage Großhandel\"", "bales, per kg, B2B, export" |
| `domain.mjs:108-118` | The domain is a trade: "sourced, sorted, graded and packaged", "the history of the brands" |
| `valuecase.mjs:10, 15` | "mileage … cars are ordered by Pareto layers"; "service book, first owner, timing belt, clutch, brakes, rust" |
| `valuation.mjs:14-26, 35` | Year, mileage and engine patterns in Czech, German and Polish ("rok vyroby", "baujahr", "rocznik", "najezd", "tdi", "stk") |
| `candidates.mjs:212-226` | `HARD_SEA_KM = 20`, `HARD_CAMPING_MONTHS = 10`: **a hard constraint the asker of another research never gave** |
| `candidates.mjs:231, 261` | "likely a part, a deposit or an instalment"; "validated for used vehicles" |
| `strategy.mjs:13-135` and on | The whole glamping strategy: sources, quotes, rules, Vietnam and Portugal law, bell tents. 78 domain hits. `purpose.mjs:2` imports from this file |
| `proposal.mjs:11-18, 97` | The six objectives (sea, camping months, climate days); section texts |
| `templates.mjs:33-100` | The glamping template and its words |
| `site.mjs:12, 27-29`, `cci.mjs` | `EBIKE_KM`, `PITCH_M2`, `CAMPING_SHARE`, `RURAL_PARK_MAX_PITCHES`; the Camping Climate Index |
| `workbook.mjs:100` | Columns "glamping units", "campsites within 15 km" |
| `prompts.mjs:6, 124-127` | Region to language map (30 countries, VN included); "cars" in the query-plan prompt |
| `brief.mjs:26, 33` | Country word lists |
| `fundamentals.mjs:6-30` | Paths and function names of this repository as data. Not a domain violation; it is documentation stored as code, and it goes stale without a test of each path |
| `local/speed.mjs:6` | Bench prompt: "why coastal rural land in southern Spain can be cheap to buy but costly to prepare". Harmless to results; a research's words in `src/` |
| `purpose.mjs:15-17` | Cost phase examples: "minimum order, registration", "delivery, duties", "returns, repairs, resale". A purchase of goods; mild |

**Research ids:** none in `src/` (grep). **Clean of all three:** `semantic.mjs`, `spans.mjs`, `scoping.mjs`, `facts.mjs`, `ach.mjs`, `verdict.mjs`, `embedder.mjs`, the router, branch `factors.mjs` and `factorstats.mjs`.

**Hard constraints that are not the asker's:** `HARD_SEA_KM`, `HARD_CAMPING_MONTHS` (`candidates.mjs:212-213`); every clause the checklist samples mark hard (U3); the kind check, always hard (`verdict.mjs:35-39`), with fixed options "a part or an accessory", "a wanted ad or a service" that fit goods and not a trail or a library; `isExcludedSurfaceUrl` dropping any URL with `/blog/` or `/guide/` in its path (`acceptance.mjs:300, 310`).

---

## 8. Baseline

### 8.1 What is measured today

| Logic piece | Unit tests (cases) | Replay metric | Live metric |
|---|---|---|---|
| Scoping | 26 | hosts across perspectives; knowledge sources dropped as off-market; second-opinion agreement; notes quoted on the page | none |
| Requirements | in `purpose` (59) | coverage | none |
| Purpose | same | none (suppliers: implications with direction low, read by a person) | none |
| Tensions | same | goals per voted pair, cited explanations, gaps; `expect.tensions = 0` for library and trail | none |
| Value and cost sides | same | present exactly when consumes; three phases; checker rule | none |
| Goals, trace, critique | same | kept without a trace; proposed and conflict listed for reading | none |
| Numbers | same | unlabelled thresholds; invented in free text | none |
| Factors (branch) | 32 + 23 | 12 rows (spec §8), run with fakes only | none |
| Facts, ACH | 12 + 7 | car only: wrong-subject facts, model-label grades, other-market prices, non-diagnostic rows | none |
| Checklist judge | 48 | car only: empty-quote answers on 20 stored pages; the tyres item | per check yes / no / unknown; `vague` |
| Deeper reads | 10 | none | pages read, checks answered (log line) |
| Verdict | 27 + 13 | none | tier counts, score, invariants |
| Router | 88 | banned-family calls; calls per stage against caps | Beta posterior per provider and purpose class; ledger |
| Embedder | 9 | model name only | none |
| Legacy decision model, domain, concept, tree | 33 + 13 + 8 + 24 | none | case utility; tree audit codes |

### 8.2 What is not measured

1. **Whether any judgement is right.** Every replay metric is structural (an id exists, a quote is on the page, a count is within a cap) or an agreement between two models. No stage has labelled answers. "Second opinion ≥ 80%" measures agreement, and two free models of one family agree on the same mistake.
2. **Repeatability.** The replay runs each research once. No stage has a run-to-run spread, so no change can be told from noise. The improve loop has a noise floor (`improve.mjs:62-64`); the pipeline that builds what the loop improves has none.
3. **Cost.** Calls per stage are counted against caps; calls and seconds per useful output (per kept source, per kept goal, per confirmed item) are not.
4. **Recall.** Precision-like checks exist (kept sources are on subject). Nothing measures what was missed: sources not found, requirements merged away, factors not stated.
5. **The live run.** No replay covers the live order. The handoff's safeguard ("read one real produced tree") is a person, not a number.
6. **Embeddings.** Whether ranked sentences contain the answer; how often the allowance runs out; how often the fallback (page opening) is used.
7. **The judge's unknown rate by cause**: not on the page, not in the 6,000 characters shown, or the model declined.

### 8.3 The minimal baseline each piece needs before it is optimised

A baseline is a frozen input, a labelled expected output, and a number with its spread over 3 runs. All inputs can be stored pages, so re-running costs model calls only.

| Piece | Frozen input | Label (made once, by the owner) | Number |
|---|---|---|---|
| Requirements | The 5 replay questions plus the stag question | The requirement list of each | Exact-match groups; spread over 3 runs |
| Hardness | Same | Hard or soft per requirement | Share right; **false hard rate** |
| Purpose, implications | Same | The intended direction per research (suppliers: small order low) | Present or not, 3 runs |
| Scoping screen | 60 stored pages across the 3 stored researches | Keep or drop, knowledge or market | Precision and recall of kept; cost per kept source |
| Notes, factor statements | 20 of those pages | The sentences that state what decides | Recall at ≤ 4 notes; statements per page |
| Goals, trace | The frozen notes | The goals a careful person lists; scope-creep goals marked | Requirements covered; creep goals kept; spread |
| Factors | Frozen statements | Which statements are one factor | Pair agreement (Rand index) |
| Checklist judge | 100 stored item pages × the stored checklist | Yes, no, unknown with the sentence | Agreement with labels; **wrong-no rate**; unknown rate by cause |
| Kind | The same 100 pages plus 20 non-items | Item or not | Wrong-no and wrong-yes |
| Deeper reads | 30 to-confirm items | Whether the answer exists on a linked page | Found share; wrong yes |
| Facts, claim pairs | 40 stored facts | Applies or not; same claim or not | Agreement |
| Verdict | The 0c750f fixture (exists) | — | Invariants (exist) |
| Router | The ledger | — | Valid-contract rate per provider and task (the data is recorded; no report reads it per task) |
| Whole run | One stored research replayed through the live order with stored pages | Confirmed items the owner accepts | Confirmed and correct of asked; calls; minutes |

The cheapest first step: the judge baseline. The pages are stored, the checklist is stored, and it is the stage where results are lost.

---

## 9. Prioritised plan

Risk: L low, M medium, H high. Each item names the test that would prove it.

| # | Fix or refactor | Files | Risk | Test that proves it |
|---|---|---|---|---|
| 1 | **Break the import cycle and repair the factors branch before it merges.** Move the role constants and bases out of `purpose.mjs` into a small `roles.mjs`; move `SCOPES`, `credibilityOf`, `SELLER_METHOD` into `admiralty.mjs`; move `clausesOf` out of `strategy.mjs`; move the leaf helpers the branch exports into `leaves.mjs`. Rebase the branch; keep main's `needsConfirmation` and `drawn`; pass the role to `relevanceReason` and the requirements to `screeningSubject`; read `role`, not `sourceClass`; make one-against-one `open` | `purpose.mjs`, `scoping.mjs`, `facts.mjs`, `strategy.mjs`, branch `factors.mjs`, `factorstats.mjs` | M | `tests/research/imports.test.ts`: import each of `purpose`, `scoping`, `facts`, `factors`, `ach` alone in a fresh worker; each must load. Fails today on the merged tree (ran). A `factors.test.ts` case: a knowledge source about another market is kept in the targeted round. A `purpose.test.ts` case: an undismissed not-modelled requirement still blocks with factors present |
| 2 | **Make a vote mean independent judgements.** A reply counts toward the quorum only from a provider family not yet counted; with one family the result is `{ value, single: true }` and callers treat it as unvoted. Record a split as "no outcome", not as a failure of every provider | `semantic.mjs`, `router.mjs` (expose the family) | M | `semantic.test.ts`: a router with one provider gives no quorum from two identical replies; with two families it does; a 1:1:1 split records no failed outcome |
| 3 | **Judge baseline, then fix the judge.** Give the judge the embedder; kind first and stop on "no"; a hard "no" needs a second provider's agreement, else unknown; record outcomes under a `checklist` purpose class; one module owns check ids and the cache shape | `checklist.mjs`, `engine.mjs` (`:303`, `:1594-1720`), `deeper.mjs`, `verdict.mjs`, `ranking.mjs`, `app.mjs`, new `checks.mjs` | M | Baseline of §8.3 on 100 stored pages: wrong-no rate before and after, 3 runs. Unit: a fact in sentence 200 of a long page is found with an embedder and unknown without; a kind "no" makes no further call; a single hard "no" is unknown |
| 4 | **Hardness from the asker, not from the checklist prompt.** One closed vote per requirement (explicit constraint, or a description, example or preference), the user's confirmation, and nothing else makes a check hard. Remove the cue words from `checklistPrompt`; remove `HARD_SEA_KM` and `HARD_CAMPING_MONTHS` | `purpose.mjs` (new vote next to `tensionsAsked`), `checklist.mjs:220`, `candidates.mjs:212-228`, `verdict.mjs` | M | Replay on stored b2f5b7: the Belgian and the French wholesaler are not rejected by the location hint (handoff §8 step 3). Unit: "graded a/cream" voted a description is soft; "20000EUR max" is hard |
| 5 | **Wire the purpose tree into the live run in the order of §2.5**: requirements, votes, purpose, sweep, scoping, goals, merge, critique, refine, confirm, checklist from the tree. Delete `studyDomain`, `searchHubs`' own query writer, `validateConcept`, `planKnowledgeQueries`, `gatherGroupKnowledge` and the lexical purpose test as each is replaced | `engine.mjs`, `purpose.mjs`, `scoping.mjs`, `decision.mjs`, `domain.mjs`, `concept.mjs`, `app.mjs`, `server.mjs` (`confirmTree` route) | H | `engine.test.ts`: no tree exists while the purpose is missing; no search runs before the purpose; a research with an open entry stops in `needs-confirmation`; the checklist ids equal the tree's page questions. Witness (S7): `scripts/dryrun.mjs` on copies of 0c750f, b2f5b7, b7772e, every tier change read. One produced tree read by the owner |
| 6 | **Refine after merge and critique; factors after that** | `purpose.mjs:905-943`, branch `factors.mjs` | L | `purpose.test.ts`: with two goals the fake votes the same, `router.count('refine')` is 1, not 2; `count('same-goal')` for a critique merge of an already judged pair is 0 |
| 7 | **Memo after the verdict** | `engine.mjs:1353-1392` (`synthesize`, `checkAcceptance`), `prompts.mjs synthesizePrompt` | L | `engine.test.ts`: the memo prompt contains the verdict summary line; the memo call is made after the last judge call (order of calls in the scripted provider) |
| 8 | **Output shape from the tree** (§6.2): columns, ranking, memo sections, list-or-not by a closed vote; remove the fixed columns, the six objectives, `COUNT_NOUNS`, `KINDS` | `workbook.mjs`, `proposal.mjs`, `result.mjs`, `acceptance.mjs`, `report.mjs`, `public/` | H | `workbook.test.ts`: a car research exports no column named "glamping units"; the column set equals the tree's `code` and `page` questions. `result.test.ts`: a German list question is a list |
| 9 | **Move research-type content out of `src/`**: the glamping strategy, site measures, seed portals, knowledge sources, the reference case, the vehicle patterns and prompts become data packs under `data/packs/<id>/`, loaded by id, never chosen by a kind word. The engine's `MEASURES` come from the tree and the pack that a research names | `strategy.mjs`, `portals.mjs`, `templates.mjs`, `knowledgesources.json`, `valueconcepts.json`, `valuation.mjs`, `valuecase.mjs`, `decision.mjs`, `checklist.mjs`, `candidates.mjs`, `engine.mjs:124-151, 1000-1039` | H | A source-text test over `src/research` and `src/search` (the pattern the branch already uses for `factors.mjs`): none of the subject words of `scripts/purpose-replay.questions.json`, none of the hosts of `SEED_PORTALS`. Witness on b7772e: the same tiers before and after |
| 10 | **Constants with a basis, and one place for shared numbers.** A `constants` test that fails when a numeric constant of a stage module is not listed in `docs/specs` with its reason (the branch's §4.9 is the model); `stats.mjs` for median, MAD, compare; delete `STAGE_CAPS` entries that are overwritten; make the embedding allowance per research; fix `concept-audit.mjs` to report "no researches" instead of crashing | `semantic.mjs`, `embedder.mjs`, `ach.mjs`, `candidates.mjs`, `strategy.mjs`, `valuation.mjs`, `scripts/concept-audit.mjs`, docs | L | `tests/scripts/constants.test.ts` as described. `embedder.test.ts`: two researches each get their own allowance. `concept-audit` test: an empty projects folder prints a line and exits 0 |

**Order.** 1 first (it blocks a merge). 2 and 3 next: they change no flow and they are the two places where a wrong result is made today. 4 before 5: the hardness vote is needed by the wiring. 6 and 7 are small and can ride with 5. 8 and 9 after a baseline exists for the whole run (§8.3 last row), because both move results. 10 at any time.

---

## Audit record

| Check | Answer |
|---|---|
| S1 Concept fit | The task reads the Ask, Research and Results flows and changes nothing. The recommendations keep "a model proposes, code decides"; items 2 to 4 tighten it |
| S2 The ask | Sections 1 to 9 of `data/AUDIT-B-CODE.md`; the branch read; reply with sections 2, 9 and the top universality violations. All done |
| S3 Current state | Code read at ed481ad and branch ee8e7d5; no live app or data on this computer |
| S4 Facts needing a source | No price, limit or external API behaviour is stated here. Citations are repeated from the specs and not opened in this audit |
| S5 Risk | None touched: no keys, token, terminal, deletion or spending |
| S6 Adjacent gaps | Listed in §2.3, §2.4, §5.4 |
| S7 Witness on live data | Not applicable (nothing changed); and not possible here |
| S8 Measurements | Counts state their source (script or grep) |
| S9, O13 Concept audit | **Blocked**: no `data/projects` in this worktree; the script crashed (plan item 10) |
| S10 Baseline self-audit | No infrastructure action taken |
| O2 Gate | Not run: no code changed. Stage tests ran: 11 files, 237 passed |
| O2b, O2c, O3, O4 | Not applicable: no change to code or to how results are produced |
| O5 Links | None in this file |
| O6 Commands | `node scripts/concept-audit.mjs --all` (ran, failed as described); `npx vitest run <files>` (ran); `node scripts/purpose-replay.mjs …` and `node scripts/dryrun.mjs <id>` (named, not run) |
| O7 Numbers | From scripts run in this session or from the cited file and line |
| O8 Secrets | None |
| O9 Claims of action | This file was written. A scratch copy of `src/` was made outside the repository to test the import order and is deleted at the end of the task |
| O11 Record | **Not done**: the task allows writing this file only, so `SESSION-LOG.md` has no entry |
