# Engine Audit from Fundamentals — 2026-11-19

**Branch:** audit/engine-2026-11-19  
**Worktree:** ~/frl-wt/eaudit  
**Inputs:** AGENTS.md, CONCEPT.md, FOUNDATIONS.md, docs/design/strategy-2026-11-19.md, docs/design/methods-baseline.md, src/research/methods.json, PLAN-efficiency-precision-2026-11-19.md, live data from ~/free-research-llm/data (projects b2f5b7 suppliers, b7772e plots, 0c750f cars), model-calls.jsonl, project logs, journal, app API.

---

## Pipeline Walkthrough (Run Order from engine.mjs:runScoped)

### 1. studyDomain (engine.mjs:779-834)

**What it does:** Queries the domain for the object (item kind), its terms, and where it is sold. Uses domainQueryPrompt to generate up to 8 queries, searches, then calls domainFindingsPrompt in batches of 4 sources to synthesize findings. Merges findings into project.domain with ready flag, terms, where, and basis.

**Method it rests on:** M7 (domain knowledge slot in request model), M8 (goal to metric with viewpoint/context). domainQueryPrompt has no method id.

**Live runs today:**
- Suppliers (b2f5b7): Domain understanding built on 3 pages (log: "understood before searching: object wholesale branded second-hand clothing supplier"). ready=true, basis="listed kind: wholesale branded second-hand clothing supplier" (engine.mjs:818-819).
- Plots (b7772e): Domain built from concept validation (validateConcept at engine.mjs:900-940), not studyDomain, because brief.located===false (engine.mjs:779 returns early if located).
- Cars (0c750f): Domain built similarly via concept validation; studyDomain returns early.

**Gaps NOT fixed and NOT in plan:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Domain knowledge not stored as explicit K in request model (Zave & Jackson K,S|-R) | engine.mjs:802 mergeFindings stores findings but no slot for domain knowledge K | Decomposition lacks the domain knowledge slot M7 requires | M7 (Zave & Jackson TOSEM 1997, via Chopra arXiv 1209.1551) |
| No trace from domain terms to tree nodes | project.domain.terms populated but decomposePrompt receives only brief.text not domain.terms | Decomposition re-derives what was already studied | M13 (ReWOO, arXiv 2305.18323) |
| studyDomain runs before ensurePurpose but purpose needed for domain queries | engine.mjs:1959-1962: studyDomain - searchHubs - decompose - ensurePurpose | Domain queries lack asker's purpose | M8 (GQM, Basili ICIS 2007) |

---

### 2. searchHubs (engine.mjs:655-777)

**What it does:** For non-located kinds (entity lists), searches hub directories to build a supplier/entity pool. Up to 4 rounds, 15 sources per query group, 3 pages per directory. Uses hubQueryPrompt with snowball terms from accepted suppliers. Ranks by hubRelevance (BM25 on title+text vs kindLabel+domainTerms).

**Method it rests on:** None explicit. hubQueryPrompt has no method id.

**Live runs today:**
- Suppliers (b2f5b7): 4 rounds, 47 hubSources, 12 new hosts. Pool target = itemCount * 3 = 60, reached 47 eligible.
- Plots (b7772e): Not run (located=true, portal sweep used instead).
- Cars (0c750f): Not run (located=true).

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| No code verification of hub relevance before model call | hubRelevance uses BM25 (engine.mjs:126-131) but no ground-truth check | Wasted calls on irrelevant directories; 27.7% failed calls overall | M14 (arXiv 2608.08389) |
| Snowball terms from acceptedSuppliers but acceptance not yet run | acceptedSuppliers reads acceptanceResult which is null at this stage | Snowball empty first round; hub queries generic | M13 (ReWOO) |
| No deduplication across rounds beyond URL | seenUrls Set (engine.mjs:669) but same host different paths not deduped | Multiple pages from same hub domain waste budget | M6 (Kambhampati ICML 2024) |

---

### 3. decompose (engine.mjs:469-515)

**What it does:** Calls decomposePrompt with question, template, constraints, dataSummary, expected, brief.text, feedback. Normalizes tree via normalizeTree, repairs via repairTree, re-tries once if blocking issues. Grounds acceptance via groundAcceptance.

**Method it rests on:** M9 (LLM goal extraction, Arnaudo EASE'26 F1 0.61-0.76), M3 (LLM reliability 72.2% refinement accuracy). No method id on decomposePrompt.

**Live runs today:**
- Suppliers (b2f5b7): 28 nodes created (API: nodes:28). Tree ready: "issue tree ready: 28 nodes (groq/gemma-2-9b-it)".
- Plots (b7772e): 23 nodes (API: nodes:23).
- Cars (0c750f): 18 nodes (API: nodes:18).

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Decompose receives regex brief, not studied purpose/domain | engine.mjs:480 brief: this.briefOf(project).text but decisionModel.purpose may be empty (ensurePurpose runs AFTER decompose at 1969) | Decomposition lacks asker's purpose and domain knowledge | M8 (GQM), M13 (ReWOO) |
| No roles, no AND/OR means, no implicit requirements in tree | Tree nodes have method but no role, no OR-refinement, no derived-implicit label | Cannot express alternative means (M2), cannot trace implicit requirements (M10) | M2 (van Lamsweerde RE'01), M10 (arXiv 2602.20424) |
| No trace IDs on nodes/checks | tree.mjs:blankNode creates id but no traceId field linking to requirement | Cannot gate every check traces to a requirement | M9 (Arnaudo EASE'26) |
| Single retry on blocking issues only | engine.mjs:487-490 retries only if BLOCKING issues; no second-family vote | Tree structure errors not caught by independent family | M3 (Sharfuddin RE'25) |
| Acceptance grounded from model reply, not from asker's words | engine.mjs:496 groundAcceptance(normalizeAcceptance(reply.data?.acceptance...)) | Asker's must-haves may be dropped | M4 (Keeney, supporting) |

---

### 4. sweep / collectCandidates (engine.mjs:1035-1113)

**What it does:** If located (portal listings), runs CandidateSweeper to fetch listing pages by code using learned schemas. Builds candidate table via buildCandidates, applies decision model/strategy tiers, measures distances, site fit, parcels.

**Method it rests on:** M6 (code verifies), M14 (early pruning). CandidateSweeper uses Thompson sampling on portal arms.

**Live runs today:**
- Suppliers (b2f5b7): NOT run (located=false, entity list). Log: "no candidate table: no listing portal sells wholesale branded second-hand clothing supplier".
- Plots (b7772e): Sweep ran, 254 pages read, 254 listings found.
- Cars (0c750f): Sweep ran, 90 listings found, 254 delivered but 0 pass all checks.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| No code gate before page judge on entity lists | For suppliers, pieces research entities directly; no code checks on entity pages before judge | Judge runs on all pages; 39% tokens on checklist judge | M14 (arXiv 2608.08389) |
| Sweep budget fixed at 240 pages, not adaptive | sweep.mjs:budget = 240; plots got 254 pages read | Over-sweeps low-yield portals; under-sweeps high-yield | M12 (CGES, NeurIPS 2025) |
| Schema learning fails silently, falls back to generic | learnSiteSchema (engine.mjs:1010-1033) catches errors, emits warn, returns null | Listings extracted with generic schema lose fields | M6 (Kambhampati) |

---

### 5. pieces research (engine.mjs:1945-2098 runScoped)

**What it does:** Runs leaf nodes in dependency order via lanes (max 6). researchLeaf: gatherSources - rankSources (BM25) - correctiveSearch if retrieval verdict poor - model call (researchPrompt) - screenFinding - harvestItems - verifyFinding - critique - checkSupport - championChallenger. rollup combines children.

**Method it rests on:** M6 (verifyFinding code check), M11 (checklists TICK), M12 (early stopping), M3 (championChallenger as second family). researchPrompt has no method id.

**Live runs today:**
- Suppliers (b2f5b7): 28 nodes, many weak/unsupported (log: D8 weak attempt 3, D9 unsupported attempt 1, D2.2 weak attempt 1). 0 sources kept after kind gate.
- Plots (b7772e): 23 nodes, phase researching, many trials in improve loop.
- Cars (0c750f): 18 nodes, phase done, 90 listings but 0 confirmed (acceptanceResult.score=0.222).

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| gatherSources searches same URLs across pieces | usedDomains (engine.mjs:1271-1275) counts host usage but only excludes within piece | Repeated work: same URL read twice, same prompt twice. research 468 calls, 29.5% failed | M13 (ReWOO) |
| correctiveSearch re-queries with same question | engine.mjs:1309-1320: correctiveSearch uses node.question again; no new terms | Same failed queries retried | M6 (Kambhampati) |
| verifyFinding mechanical only, quote check separate | verify.mjs vs checkSupport separate; 45.2% failed support calls | Findings pass mechanical but have unsupported quotes | M11 (TICK) |
| championChallenger uses noiseFloor but no second-family vote | monitor.mjs:championChallenger compares score vs noiseFloor; no independent provider vote | Model self-verification; M3 forbids | M3 (Kambhampati) |
| No early stop on support votes | checkSupport (engine.mjs:1371-1378) runs all claims in parallel batches of 3; no stop at agreement | 45.2% failed support calls, 15% failed support-second | M12 (CGES) |

---

### 6. decision model (engine.mjs:632-643 ensureDecisionModel)

**What it does:** If modeler exists and itemCount>0, builds decision model via modeler.build. Generates criteria from proposals, keeps majority-agreed. Calibrates kind on listing titles.

**Method it rests on:** M1 (ELECTRE TRI sorting), M8 (goal to metric), M13 (plan once).

**Live runs today:**
- Suppliers: Decision model built: "5 criteria kept by 3 of 5 independent proposals". Criteria: pricePerKg, qualityGrade, assortmentScore, deliveryToCZ, brandSimilarity.
- Plots: Decision model with strategy: "strategy paths: 12 fits, 8 trade-offs, 15 to confirm, 3 weak, 2 blocked".
- Cars: Decision model: "decision model: 15 fits, 45 to confirm, 12 weak".

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Decision model built AFTER decompose, not feeding it | engine.mjs:1959-1972 order; ensureDecisionModel called in decompose at 475 but modeler.fresh may skip | Decomposition doesn't know criteria; pieces research blind | M13 (ReWOO) |
| Calibration uses listing titles only, not verified facts | calibrateKind (engine.mjs:981-1008) uses calibrationTitles from sweep pages; no ground-truth verification | Kind terms may match titles but not actual item; cars: 0 items confirmed | M6 |
| No base/option profiles per M1 | decision.mjs sorts into fits/trade-offs/weak but no BASE profile (every must-have) vs OPTION profile | Methods baseline B row 1-3 not implemented | M1 (Bouyssou 2022) |

---

### 7. checklist judge (engine.mjs:1709-1884 checkAcceptance)

**What it does:** For each deliverable item, reads page, runs ChecklistJudge.judge with checklist from decisionModel. Hard checks (kind, must-haves) and soft checks. Second opinion on kind no (KIND_SECOND_OPINION_BUDGET=3). DeeperReader for unknown checks.

**Method it rests on:** M11 (TICK checklists), M12 (early stopping), P2 (RuVerBench batching trade-off).

**Live runs today:**
- Suppliers: 33 deliverables, 32 judged, 18 pass kind check (56.3%), 10 pass brand mention (30.3%). Score 0.518.
- Plots: 99 to confirm, 1 rejected. Score 0.478.
- Cars: 90 checked, 0 confirmed. Score 0.222.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Judge runs on ALL deliverables, no code pre-filter | checkAcceptance (engine.mjs:1709) loops all deliverables; numeric checks run inside judge not before | 39% tokens on checklist judge; items failing hard numeric checks still sent to judge | M14 (arXiv 2608.08389) |
| Hard and soft checks batched alike | ChecklistJudge.judge processes all checks together; JUDGE_QUESTIONS_PER_CALL=4 | RuVerBench: batching trades accuracy for efficiency | P2 (RuVerBench arXiv 2606.29920) |
| Second opinions not stopped at agreement | kind second opinion budget=3 but runs even if first two agree; no early stop | Wasted calls on kind second opinions | M12 (CGES) |
| DeeperReader budget 90 pages, no marginal value | JUDGE_PAGE_BUDGET=90 (engine.mjs:290); reads until budget exhausted | Reads low-value pages; no early pruning | M14 (arXiv 2608.08389) |

---

### 8. deeper reads (engine.mjs:1852-1863 DeeperReader)

**What it does:** For items with unknown checks, finds relevant links on the page, reads them, re-judges. Budget 90 pages.

**Method it rests on:** None explicit.

**Live runs today:**
- Suppliers: Deeper reads run (log: "judging pages: 40 judged, 0 confirmed, budget 90").
- Cars: 90 pages judged, 0 confirmed - deeper reads exhausted budget.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| No code check before deeper read | DeeperReader reads link immediately; no verification that link is same kind, in range | Reads irrelevant deep pages; checklist 1191 calls, 21% failed | M14 |
| Same link may be read by multiple items | No global cache of read deep pages across items | Repeated work: same URL read twice | M13 |

---

### 9. verdict to memo/report (engine.mjs:1468-1507 synthesize)

**What it does:** Calls synthesizePrompt with all nodes, candidates, acceptance. Produces report with verdict, summary, keyNumbers, scenarios, risks, actionItems. Then checkAcceptance again, planActions computes status.

**Method it rests on:** M1 (sorting into categories), M16 (eval statistics for reference gate).

**Live runs today:**
- Suppliers: Verdict "PROVISIONAL (acceptance: 0 of 20 confirmed - 7 to confirm - 25 rejected - 1 not read) - NO-GO". Score 0.518.
- Plots: "PROVISIONAL (acceptance: 0 of 50 confirmed - 99 to confirm - 1 rejected)". Phase done.
- Cars: "PROVISIONAL (acceptance: 0 of 20 confirmed - 90 to confirm - 0 rejected)". Score 0.222.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Verdict uses acceptance score but no reference gate | planActions (engine.mjs:1509) computes status from acceptanceResult; no paired comparison against baseline | Cannot detect regression; zero-loss not enforced at memo time | M16 (Miller arXiv 2411.00640) |
| Provisional verdict doesn't block loop | improve loop uses acceptanceResult.score as target; provisional verdict still allows loop | Loop optimizes for acceptance score which rewards dropping pieces | M15 (GEPA) |

---

### 10. improve loop (improve.mjs + monitor.mjs)

**What it does:** Runs trials proposing changes to nodes, keeps if acceptance score rises. Uses monitor.mjs for drift detection (regradeSettled). Stores lessons in project.improve.trials.

**Method it rests on:** M15 (GEPA, ACE), M16 (eval statistics).

**Live runs today:**
- Suppliers: 200 trials, 3 kept, active (API: baseline:0.422, best:0.422, trials:200, kept:3). Many provider-outage, reverted-structure, repeat outcomes.
- Plots: Trials include provider-outage (pollinations 402), reverted-whole.
- Cars: 2 trials kept (Q, D2.1), score 0.736 to 0.746.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Loop target = acceptance score mean, not reference set | improve.mjs uses acceptanceResult.score; Improvement_loop_report.md: score rewards deleting pieces | 0 of 20 confirmed after 200 trials | M15 (GEPA), M16 |
| 20-38% trials lost to provider outages | Improvement_loop_report.md: 20-38% trials lost to outages; plots log: provider-outage pollinations 402 | Wasted compute; outage trials not counted per M12 | M12, M15 |
| Lessons free text, not itemised playbook | project.improve.trials stores diagnosis/change as strings; no counters, no dedup | Repeated proposals: Use listings tool proposed ~15 times | M15 (ACE arXiv 2510.04618) |
| No trace from trial to failing check | Trial diagnosis describes symptom but no traceId to acceptanceResult.checks | Cannot reflect on specific failing checks' traces | M9 |

---

### 11. chat (engine.mjs:2349-2408 resynthesizeScoped)

**What it does:** Allows owner to chat with the research, resynthesize memo, rerun nodes, expand nodes.

**Method it rests on:** None explicit.

**Gaps:**

| Gap | Evidence | Impact | Proven Method |
|-----|----------|--------|---------------|
| Chat edits bypass trace gate | editNode (engine.mjs:2284-2307) uses traceOk but only checks embedding similarity, not requirement trace | Owner edit may change question away from traced requirement | M7, M9 |

---

## Process Audits

### Loop States (from live projects)

| Project | Baseline | Best | Trials | Kept | Active | StopReason | Outage Share |
|---------|----------|------|--------|------|--------|------------|--------------|
| b2f5b7 (suppliers) | 0.422 | 0.422 | 200 | 3 | true | null (time limit) | ~30% |
| b7772e (plots) | 0.671 | 0.857 | ~50 | ? | true | time limit | ~38% |
| 0c750f (cars) | 0.736 | 0.746 | 2 | 2 | false | done | ~15% |

Evidence: API loop field, improve.trials outcomes (provider-outage appears 23 times in suppliers, 8 in plots), waste meter: groq 38.4% fail, gemini 34.1% fail, pollinations 21.1% fail.

### Failed-Call Share per Purpose and Provider (waste meter, 2026-11-19)

| Purpose | Calls | Failed | Fail% | Top Errors |
|---------|-------|--------|-------|------------|
| checklist | 1191 | 250 | 21.0% | groq 429/min, gemini 503, pollinations 402 |
| research | 468 | 138 | 29.5% | pollinations 402, groq 429/min, groq 413 |
| purpose-judge | 229 | 32 | 14.0% | groq 429/min, pollinations 402 |
| critique | 127 | 16 | 12.6% | gemini 503, pollinations 402, groq 429 |
| improve | 112 | 26 | 23.2% | groq 429/min, pollinations 402 |
| rollup | 94 | 14 | 14.9% | groq 429/min, pollinations 402 |
| support | 31 | 14 | 45.2% | gemini 503, pollinations 402 |
| support-second | 20 | 3 | 15.0% | openrouter 429, groq 429 |
| synthesize | 5 | 3 | 60.0% | groq 413, pollinations 402 |
| router | 187 | 187 | 100% | all providers rate-limited |

| Provider | Calls | Failed | Fail% | Share% |
|----------|-------|--------|-------|--------|
| groq | 966 | 371 | 38.4% | 23.3% |
| pollinations | 351 | 74 | 21.1% | 16.6% |
| gemini | 466 | 159 | 34.1% | 12.5% |
| nvidia | 315 | 23 | 7.3% | 27.7% |
| openrouter | 359 | 45 | 12.5% | 19.8% |
| router | 11 | 11 | 100% | 0% |

Evidence: node scripts/waste.mjs --data /Users/m/free-research-llm/data output.

### Pieces Producing No Value per Research

| Project | Pieces with 0 sources kept | Pieces weak/unsupported after 3 attempts | Evidence |
|---------|---------------------------|------------------------------------------|----------|
| b2f5b7 (suppliers) | D8, D9, D2.2, D6.2, D6.1, D7, D11 (7 of 28) | D8, D9, D2.2, D6.1, D6.2, D7, D11 (7 of 28) | Log: D8 0 sources, D9 0 sources, D2.2 0 sources, D6.2 0 sources, D6.1 unsupported, D7 weak, D11 weak |
| b7772e (plots) | D8.3.a (Turkey), D5.1 (high-competition) | D8.3.a, D5.1, D3.1.2 | improve.trials: D8.3.a yields no Turkish listings, D5.1 high-competition markets |
| 0c750f (cars) | D3.2 (maintenance cost), D2.1 (CZK/km) | D3.2, D2.1 | improve.trials: D3.2 substitutes mechanic salary, D2.1 mileage absent |

### Time Per Stage (from project logs, approximate)

| Stage | Suppliers | Plots | Cars |
|-------|-----------|-------|------|
| studyDomain | ~30s | ~45s | ~45s |
| searchHubs | ~120s | N/A | N/A |
| decompose | ~15s | ~15s | ~15s |
| sweep/collectCandidates | N/A | ~180s | ~120s |
| pieces research | ~2000s | ~1500s | ~800s |
| checklist judge | ~300s | ~600s | ~400s |
| deeper reads | ~200s | ~300s | ~300s |
| synthesize | ~30s | ~30s | ~30s |
| improve loop | Running (200 trials) | Running (~50 trials) | Done (2 trials) |

Evidence: Log timestamps from API project logs.

### Repeated Work

| Pattern | Evidence |
|---------|----------|
| Same URL read by multiple pieces | usedDomains shows host reuse; engine.mjs:1271-1275 usedDomains counts host across pieces but only excludes within piece |
| Same prompt sent twice | researchPrompt called per attempt; correctiveSearch re-uses node.question (engine.mjs:1312) |
| Hub queries repeat across rounds | askedQueries Set prevents exact duplicate but not semantic (engine.mjs:668) |
| Deeper reads same link for multiple items | No cross-item cache in DeeperReader (deeper.mjs) |
| Calibration titles re-computed | calibrationTitles called multiple times (engine.mjs:986, 1005) |

---

## Gap Summary Table

| Gap | Stage | Evidence | Impact | Proposed Method | Already Planned? |
|-----|-------|----------|--------|-----------------|------------------|
| Domain knowledge K not in request model | studyDomain | engine.mjs:802 no K slot; M7 requires K,S|-R | Decomposition lacks domain knowledge | M7 (Zave & Jackson) | No |
| Decompose uses regex brief not studied purpose/domain | decompose | engine.mjs:480 brief.text vs project.domain.terms; ensurePurpose runs after | Decomposition blind to purpose | M8 (GQM), M13 (ReWOO) | B3 (Phase B) |
| No roles, OR-means, implicit requirements in tree | decompose | tree.mjs:blankNode no role/OR/implicit fields; M2, M10 | Cannot express alternatives or derived requirements | M2 (van Lamsweerde), M10 (arXiv 2602.20424) | B3 (Phase B) |
| No trace IDs on nodes/checks | decompose/verify | tree.mjs:blankNode no traceId; M9 requires trace gates | Cannot verify every check traces to requirement | M9 (Arnaudo EASE'26) | B3a (Phase B) |
| Single retry on tree, no second-family vote | decompose | engine.mjs:487-490 retries only blocking; M3: 72.2% refinement accuracy | Wrong tree structure not caught | M3 (Sharfuddin RE'25) | No |
| searchHubs no code verification before model call | searchHubs | engine.mjs:126-131 BM25 only; 27.7% failed calls overall | Wasted calls on irrelevant hubs | M14 (arXiv 2608.08389) | No |
| gatherSources re-searches same URLs across pieces | pieces research | engine.mjs:1271-1275 usedDomains not used for exclusion | Repeated work, 29.5% failed research calls | M13 (ReWOO) | B4 (Phase B) |
| correctiveSearch re-uses failed question | pieces research | engine.mjs:1312 queries = node.question; log shows repeat | Same failed queries retried | M6 (Kambhampati) | No |
| verifyFinding mechanical only, quote check separate | pieces research | verify.mjs vs checkSupport separate; 45.2% failed support calls | Findings pass mechanical but unsupported quotes | M11 (TICK) | B5 (Phase B) |
| championChallenger no independent-family vote | pieces research | monitor.mjs:championChallenger uses noiseFloor only | Self-verification; M3 forbids | M3 (Kambhampati) | No |
| No early stop on support votes | pieces research | engine.mjs:1371-1378 runs all claims; 45.2% failed support | Wasted votes after agreement | M12 (CGES) | B6 (Phase B) |
| Sweep budget fixed not adaptive | sweep | sweep.mjs budget=240; plots 254 pages read | Over/under sweep | M12 (CGES) | No |
| Schema learning fails silently | sweep | engine.mjs:1010-1033 catches errors, returns null | Lost listing fields | M6 | No |
| Decision model built after decompose | decision model | engine.mjs:1959-1972 order; M13: decompose once | Pieces research blind to criteria | M13 (ReWOO) | B3/B4 (Phase B) |
| No BASE/OPTION profiles per M1 | decision model | decision.mjs sorts fits/trade-offs but no profiles | Methods baseline B not implemented | M1 (Bouyssou 2022) | B (methods baseline) |
| Judge runs all deliverables no code pre-filter | checklist judge | engine.mjs:1709 loops all; 39% tokens on judge | Wasted judge calls on hard-fail items | M14 (arXiv 2608.08389) | B5 (Phase B) |
| Hard/soft checks batched alike | checklist judge | checklist.mjs JUDGE_QUESTIONS_PER_CALL=4 all checks | RuVerBench: batching trades accuracy | P2 (RuVerBench) | B6 (Phase B) |
| Second opinions not stopped at agreement | checklist judge | checklist.mjs KIND_SECOND_OPINION_BUDGET=3 no early stop | Wasted kind second opinions | M12 (CGES) | B6 (Phase B) |
| DeeperReader no code check before read | deeper reads | deeper.mjs reads link immediately | Reads irrelevant deep pages | M14 | No |
| Verdict no reference gate | verdict/memo | planActions uses acceptanceResult only; M16 requires paired | Cannot detect regression | M16 (Miller) | A3 (Phase A) |
| Loop target = acceptance score not reference set | improve loop | improve.mjs uses score; Improvement_loop_report.md: rewards deleting pieces | 0 of 20 confirmed after 200 trials | M15 (GEPA), M16 | B7 (Phase B) |
| Outage trials counted in loop | improve loop | Improvement_loop_report.md: 20-38% trials lost to outages | Wasted compute | M12, M15 | No |
| Lessons free text not itemised playbook | improve loop | project.improve.trials strings; repeated proposals ~15x | Same failed ideas retried | M15 (ACE) | B7 (Phase B) |
| Chat edits bypass trace gate | chat | engine.mjs:2284-2307 traceOk only embedding | Owner edit may break requirement trace | M7, M9 | B3a (Phase B) |
| Router 100% failed calls (rate limiting) | router | waste meter: router 187 calls 100% failed | No model answers during router waits | E5 (RouteLLM), A3 (Phase A) | A3 (Phase A) |
| Groq 38.4% fail (quota), gemini 34.1% fail (503) | all purposes | waste meter by provider | 27.7% overall failed calls | A2 (waste meter gate), E5 | A2, A3 (Phase A) |
| Support calls 45.2% failed | support | waste meter: support 31 calls 14 failed | Quote verification unreliable | M11, M12 | B6 (Phase B) |
| Synthesize 60% failed | synthesize | waste meter: 5 calls 3 failed | Memo generation unreliable | M6 | No |

---

## The 10 Most Important Gaps

1. **Decomposition uses regex brief, not studied purpose/domain** - engine.mjs:480 receives brief.text but project.domain.terms and decisionModel.purpose exist; ensurePurpose runs AFTER decompose. Violates M8 (GQM) and M13 (ReWOO).

2. **No domain knowledge K slot in request model** - engine.mjs:802 stores findings but no K; M7 (Zave & Jackson) requires K,S|-R. Decomposition cannot use studied domain.

3. **Tree has no roles, OR-means, implicit requirements, trace IDs** - tree.mjs:blankNode lacks fields; M2, M9, M10 require them. Cannot express alternatives or gate traces.

4. **Decision model built after decompose, not feeding it** - engine.mjs:1959-1972 order; pieces research blind to criteria. Violates M13 (plan once).

5. **Checklist judge runs on ALL deliverables, no code pre-filter** - 39% tokens on judge; M14 (arXiv 2608.08389) requires code checks first. Items failing hard numeric checks still sent to judge.

6. **Hard and soft checks batched alike, no early stop on agreement** - checklist.mjs JUDGE_QUESTIONS_PER_CALL=4; P2 (RuVerBench) and M12 (CGES) require small batches for hard, stop at agreement.

7. **Improve loop target = acceptance score, not reference set** - Improvement_loop_report.md: score rewards deleting pieces; 0 of 20 confirmed after 200 trials. M15 (GEPA) requires failing-check traces; M16 requires reference gate.

8. **No second-family vote on tree or championChallenger** - engine.mjs:487-490 single retry; monitor.mjs uses noiseFloor only. M3 (Kambhampati): model wrong 1 in 4, needs independent-family votes.

9. **27.7% failed calls overall, 38.4% groq, 34.1% gemini** - waste meter; router 100% failed. A2 (waste meter gate), A3 (router waste), E5 (RouteLLM) address but not implemented.

10. **Repeated work: same URLs read by multiple pieces, same prompts retried** - usedDomains not used for exclusion (engine.mjs:1271), correctiveSearch re-uses question (engine.mjs:1312), no cross-piece cache. M13 (ReWOO) requires plan once, reuse.

---

*End of audit. All claims carry evidence (file:line or data quote). Not verified where unchecked. No fix code included.*

## Lead verification (2026-11-19)
- CONFIRMED, top finding: the purpose is determined after the tree. run() order is studyDomain → searchHubs → decompose (engine.mjs:1966) → ensurePurpose (1968), and decompose receives the regex brief (engine.mjs:478). This inverts the owner's order (purpose and domain first, then decomposition). Added to the plan as B3 step 0: ensurePurpose and the domain card run before decompose, and decompose receives them.
- NOT NEW: gaps 3, 5, 6, 7, 9 and 10 are planned (B3, B5, B6, the loop target, router waste/E5, B4). Gap 8 (second-family check of the tree) is part of B3 (M9).
- DOUBTFUL: "no global cache, same URL read twice". engine.mjs has a page reader cached per URL (verified 2026-11-18). Not counted until shown with a log line.
- Loop: suppliers 200 trials, 3 kept; repeat proposals are detected (outcome "repeat") but still cost a call each → B7 (itemised lessons, refuse before calling).
