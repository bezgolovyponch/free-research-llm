# Master plan — human-line decomposition engine (2026-11-20)

One plan for the owner, the Mac lead (Claude), Fable 5.2 (PC lead) and the fcc workers on both machines. It replaces every earlier list. Item names below are the only names used.

Revision 4, 2026-11-20: revision 3 plus the CRISP-DM process of §1 (#249) and the changes of plan-review-2026-11-20 (coverage gate applied to the plan itself; exits stated per class; baseline, meter, tiers, claim cascade, entity resolution, declared coverage and a memory-off control added).

Revision 4.1, 2026-11-20: owner approval of revision 4 recorded, with two conditions — (A) item 0.2 must exist before any merged stack is described as no-loss (witness researches b2f5b7, 0c750f, b7772e, fbadb7); (B) coverage uses the code-verified incidence forms (§2 row 9 coverage). Standing rules added: the quote gate runs before the code, never after; a worker run returning zero verifiable quotes is a failed run, never a finding; cost ratios are class-typed (for a discovered space the dominant loss is a missed valid item, for a declared space a wrong confirmed item). §1's sources are quote-gated (Wirth & Hipp 8 spans, Data Interpreter 6, Tan 9, in D:/frl-sim/quote-gates-1120; Hyndman pending a browser-capable read). Request-level choices (such as which city a live run researches) stay out of the plan until the engine work is done.

## 1. The process we implement: CRISP-DM, for every research (revision 4)

No research classes with their own pipelines. One validated standard process runs for every research; the request's business understanding decides what each phase does.

- CRISP-DM (Wirth & Hipp 2000; CRISP-DM 1.0): business understanding → data understanding → data preparation → modelling → evaluation → deployment, iterative.
- Its forecasting form (Hyndman & Athanasopoulos, Forecasting: Principles and Practice, "basic steps"): problem definition → gathering information (statistical data and accumulated expertise) → exploratory analysis → choosing and fitting models → using and evaluating; simple methods are the benchmark a model must beat.
- LLM evidence: Data Interpreter (Hong et al. 2024, arXiv 2402.18679): a hierarchical task graph with each sub-problem verified raised accuracy "from 75.9% to 94.9%" on InfiAgent-DABench; Tan et al. NeurIPS 2024: LLM components do not improve forecasting → code computes, the model never does.
- Scope (owner, 2026-11-20): CRISP-DM is phase vocabulary and reporting structure over data already in hand; source admission, sufficiency and the value-of-information stop are acquisition mechanisms outside it (§2 rows 5–9 and the Phase 3 machinery). Nothing mechanises from §1's sources alone.

| Phase | In FRL | Model proposes | Code decides |
|---|---|---|---|
| 1 Business understanding | purpose, deliverable (row unit, columns, operations, output format), requirements, roles, constraints — from the asker's words | the spec | each element quoted from the request; two families agree |
| 2 Data understanding | the tree: pieces that find and read the sources each column needs (data and expertise) | queries, pieces | every piece serves a column or operation |
| 3 Data preparation | the result rows: values with quotes | rows | quote found on the page; number in the quote; dedupe |
| 4 Modelling | operators named by the request (screen, rank, aggregate, trend+forecast, compare, formula) | which operator the words ask for | operators are code; Theil–Sen, seasonal naive, Pareto, … |
| 5 Evaluation | gates, verifier, benchmarks, coverage, zero-loss | — | a model must beat the simple benchmark; uncertainty stated |
| 6 Deployment | the deliverable rendered in the asked format | — | the table/CSV is the result; a memo is secondary |

Plots already follow it (candidate table = phase 3, screening/ranking = phase 4, verifier = phase 5, proposal table = phase 6). The freight research failed because phases 3, 4 and 6 did not exist for it.

Rules the phases carry (revision 4):

| Phase | Element | Rule |
|---|---|---|
| 1 Business understanding | Contract | what is delivered, stated per tree piece by three facts: the unit of the answer (an item, a claim, a number), whether the space is named by the asker or must be discovered, and how the answer is put together. The class (list, analysis, decision) is a label derived from these facts; one request may hold several |
| 1 Business understanding | Roles | actors and places with the role the request's own frame gives them; the engine holds no list of roles |
| 3 Data preparation | Evidence | a memo or an analysis is split into claims; each claim is checked against the pages it cites. Every unit shows its tier: recomputed, extracted and verified, or admitted |
| 5 Evaluation | Verdict | coverage stated for every class (discovered space: found against an estimated floor; declared space: share of result-affecting pieces settled) and confidence built from the tier, the share of code-verified evidence and the agreement of independent model families, never from a model's own score |
| 5 Evaluation | Learning | every learning gate compares against the same run with memory off |

## 2. Method basis (verified quotes live in src/research/methods.json and docs/design/methods-baseline.md)

Each cell carries a trust mark: QC (quote-checked), k/N (spans found), AX (arXiv title and date only), M (methods.json id), W (worker answer, not yet quote-gated), U (unverified). A step whose row is not covered on both sides by QC, k/N or M entries may be designed and is not built.

| Step | Fundamental (verified) | Recent LLM evidence (verified) | Use |
|---|---|---|---|
| 1–5 request model | Zave & Jackson K,S⊢R (M7); KAOS AND/OR refinement (M2); GQM purpose/viewpoint/context (M8); iStar roles | LLM goal extraction F1 0.61–0.76, best as an accelerator (M9); implicit requirements are the main agent failure (M10) | model proposes the model, code checks quotes and trace; a second family reviews |
| 2 contract | systematic review stages (PRISMA, FOUNDATIONS) for lists only (U; list only; analysis and decision: open, gap lookup) | WebShaper 2507.15061 (AX); 2601.17617 (AX) | routes stages by class (E-A merged); Fable v2: product = decision memo, lists one class |
| 4 alternative means | KAOS OR-refinement (M2) | grounded expansion from pages, not model memory (LLM-Modulo M6) | pages name alternatives |
| 5 roles | iStar (1/4 — "Actors exercise intentionality" verified; the dependency mechanism unread, gap still open) | none (gap lookup) | design only until covered |
| 6 domain knowledge | sensemaking n03 (8/16), foraging f02 (5/15) | TaxoBench 2601.12369 (AX); 2505.12694 (AX); S1-2 pending | design only until S1-2 is read |
| 7 research path | means-ends f04 (QC); marginal value p04 (QC); Thompson l27 (2/4) | early pruning M14; 2602.22675, 2603.15262 (AX); ADaPT + DeepSearchQA (6 spans — as-needed decomposition; the stopping failure pair: premature stopping vs hedging) | pieces name the requirement they serve; split a piece only when it fails whole |
| 8 evidence | wrapper induction (f11 QC; list). Claim checking: open, gap lookup | LLM-Modulo (M6); checklists TICK (M11); early pruning (M14); FActScore 2305.14251, SAFE 2403.18802, VeriScore 2406.19276 (W) | code first, judge only what code cannot measure; claims of a memo checked against cited pages; tiers shown |
| 9 verdict | ELECTRE TRI-nB sorting (M1) | rubric judges are noisy, batching trades accuracy (M11); judge relevance inflation (arXiv 2602.17170, PC-verified); verbalised confidence 2412.14737 (AX); conformal factuality 2402.10978 (W): not usable at the present label count; prediction-powered inference: S1-3 pending | tiers by requirements; confidence never from a model's own score; one vote per independent family per page |
| 9 coverage | Chao2 / Chao–Jost incidence coverage (Chao 1987; Chao & Colwell 2017; Chao et al. 2014 — quotes verified on PC); M17–M21: sentences verified, equation bodies transcribed only; record linkage x02 (9/10) for "same entity" | completeness is the dominant failure of wide search: WideSearch 2508.07999, DeepSearchQA 2601.20975, Total Recall QA 2603.18516 (AX) | entity resolution first; report floor + coverage deficit; sample coverage Ĉ = 1 − (Q₁/U)·A with A = (T−1)Q₁/((T−1)Q₁+2Q₂), the Q₂=0 estimate only when Q₁>1 (else report the observed count), and expected coverage after t more channels Ĉ(T+t) = 1 − (Q₁/U)·A^(t+1) as the stop rule's gain term (iNEXT code-verified; the naive 1−Q₁/U overstates the deficit); stop rule only after the one-sided check on known counts; declared space: settled share, stop by value of information (Howard 1966, 6/6 spans — the value of clairvoyance is the upper bound on paying for any evidence) |
| cost | plan once (M13) | early stopping of votes −58% calls (M12); plan caching (M13); LOTUS 2407.11418 (AX); S1-6 rerun quote-gated (Adaptive-RAG 2403.14403, 11 spans, 2026-11-20) and S2 pending reads: slots only | fewer, earlier, cheaper calls |
| 10 learning | case-based reasoning: Aamodt & Plaza 1994 (12/12 spans — the retrieve/reuse/revise/retain cycle, case = problem situation) | GEPA reflective evolution, ACE itemised playbook (M15); ACE l17 (QC); no published memory on/off held-out test found, x08 (7/12) | lessons as items with counters, verified tier only; memory-off control |
| eval | regression testing; canary analysis (SRE) | BrowseComp-Plus 2508.06600 (14 spans — fixed corpus to disentangle retrieval from reasoning); DeepResearch Bench 2506.11763 (6 spans — RACE/FACT); II 2601.08536 (AX, to be read); negative flips 2021 kept as background (U); error bars (M16); evaluator locking | zero-loss union per class, canary, integrity; baseline and noise band per class; meter by contract |

Pending, nothing built until read by the lead and the owner: **S1** (prediction-powered inference, conformal bounds, claim factuality, domain-knowledge structure, pipeline optimisation, retrieve-when-needed, entity resolution) and **S2** (2024–2026 time and token savers). Both on the PC. Quote-gate state 2026-11-20: S1-1 4/4, S1-2 4/6, S1-3 2/2, S1-4 1/3, S1-5 3/3, S1-6 rerun 11 spans, S2-1 5/6, S2-3 2/2; S1-7 and S2-2/4/5/6 await a clean verify pass. The six gap lookups ran 2026-11-20 on the free extractor chain (D:/frl-sim/quote-gates-1120/out-gaps): declared coverage/VOI 6 spans, case-based reasoning 12, evaluation window 6+14, research path 6 — covered; roles 1/4 — still open (the i* dependency mechanism needs a fuller read); claim checking as a fundamental — still open (S1-1/FActScore covers the recent side only).

## 3. Phases (each starts only when the previous exit holds)

| Phase | Content | Exit |
|---|---|---|
| **0 Foundation** | E-A contract class (merged #242); E-B analysis skips item-only stages; E-C tree-clearing cause; 0.2 a version rebuild reproduces stored verdicts (pre-merge; condition A: until 0.2 exists, no merged stack is described as no-loss — witnesses b2f5b7, 0c750f, b7772e, fbadb7); 0.3 zero-loss union over classes (list + analysis/memo rules); E-Q action queue (no "stop it first"); P0 quote-on-page core (merged #248); 0.4 baseline and noise band (analysis and memo runs recorded on free lanes with repeats, no src edit); 0.5 meter by contract (settled units per call end to end, precision by tier, supported-claim share, result stability; code only) | an analysis research runs end to end; a baseline with a noise band exists for each class; list researches unchanged (zero-loss 0 flips, canary clean) |
| **1 Request model** | D1 design by Fable (owner review) → B3.1 purpose + requirements + trace (`serves`) for all classes → B3.4 alternative means (OR) → B3.2 roles (was B2; designed in D1, built only after the roles row of §2 is covered on both sides); B3.3 knowledge pieces get sources (was B1) is designed in D1 and built only after S1-2 is read by the lead and the owner | three unrelated researches, one per class (plots, freight, action plan), plus one research that was not design evidence, get a correct model on paper and in replay; stored criteria never rebuilt |
| **2 Evidence & verdict** | P2 quote integrity (adds matches only); then three tiers on every unit, and a unit whose quote code cannot find on the page is never shown as confirmed; claim cascade named and measured for analysis and memo; verdict sorted by requirements; one vote per independent family per page; P3 climate index optional, with the two request-knowledge constants of decision.mjs removed in the same phase; code answers clauses a criterion measures (B5 merged) | list: headline = items meeting every must-have; analysis: every finding and number carries source, method and tier; memo: the verdict is traced to requirement outcomes and its numbers carry source and method; on the meter, value up and precision not down against the Phase 0 noise band, per class |
| **3 Coverage & cost** | entity resolution (every detection recorded, same entity decided by a graded match; mechanism after S1-5) → P4 coverage figures (report only) → one-sided check on known counts in two kinds of list → stop rule; declared space: settled share reported, rechecks ordered by how far the result moves; adaptive second opinions (M12); waste meter actions; router waste (R); retrieve-when-needed and cost cascades are slots, built only after S1-6 and S2 are read | calls per valid result not higher; coverage stated for every class in its own form |
| **4 Learning** | loop target = requirement outcomes + zero-loss; itemised lessons (verified only); plan reuse per contract; every gate has a memory-off control arm | against memory off, the loop's kept changes raise value on each of the three classes and lower precision on none |
| **5 Composition & fields** | fields from the request's own frame (P1 returns here), composed results from confirmed fields only | no knowledge in code (5-question check) |

## 4. Who does what (revision 3, 2026-11-20: Fable decides and leads; PC workers execute)

| Role | Owns | Does |
|---|---|---|
| **Owner** | priorities, labels, cost ratio, approvals | approves each design and every phase exit |
| **Fable 5.2 (PC) — lead** | the whole plan from here: designs D1–D5, the order of work, specs, reviews, merge decisions, the canary and zero-loss gates | decides every step; dispatches PC fcc and workers; reads every diff and real output before merging; reports to the owner |
| **PC fcc and workers** | all code: engine.mjs, deliverable.mjs, server/action queue, router, proposal/index.html, harness scripts, quote, acceptance, listings, cci | execute Fable's one-step specs |
| **Mac (Claude)** | audits only | audits the researches the owner runs (read only: logs, data, results against the asker's words and the plan's human line), reports defects with evidence to Fable and the owner; no engine code, no dispatch, no merges |

Hand-over from the Mac (state on 2026-11-20): E-A merged (#242); E-B (analysis skips item-only stages) merging as feat/contract-stages; E-C answered (pauses keep nodes; the freight tree was cleared by re-decompose); E-Q action queue in progress on branch feat/action-queue (the PC finishes or takes it over); open for the PC: 0.2 rebuild-safe check, a machine-wide quality lock (parallel gates collide on the e2e port 4610), router-waste tests (branch fix/router-waste), side report for unrequested places (fix/outside-side-report); specs for these are in the Mac's lead folder and can be re-sent on request. Of the four Mac branches only feat/contract-stages (E-B) is on origin on 2026-11-20; the owner asks the Mac to push the other three.

State on the PC after the night of 2026-11-20: P0 quote-on-page core merged (#248); the lessons of 2026-11-20 merged under dated ids (#250, 5 lessons); the Windows gates fix merged (#238); the gate-base fix is open as PR #251.

**Fable's prior work is the starting point, not a blank page.** Fable has already reviewed and combined the methods: the engine methods design v1, v1.1 dispositions on the external audit and the lead's review (28 rows: keep / accept / replace / reject, with a constants register), the engine design v2 decision (order: memo baseline, meter, quote-on-page tiers, case retrieval, fields later), and the wave-1 measurements on stored data (W1-A admission, W1-B case retrieval, W1-C fields, W1-D coverage, W1-F labels, W1-H harness). Each design below continues that work: it reuses what v1.1/v2 settled, states what changes and why, and keeps the dispositions' rules (no hand cuts — weights instead; pages name alternatives, never the model; verified vs admitted tiers; parity per valid result). Those documents are copied to docs/design/ on main so both machines read the same text.

Designs owned by Fable, in phase order (each: ≤ 4 pages, no code; continuing v1.1/v2):
- **D1 Request model (Phase 1, next; extends v2's frame/contract step and v1.1 G2 class → member → service → outcome):** purpose, contract, requirements (AND) traced to the asker's words, derived implicit requirements, alternative means (OR) found on pages, roles, domain knowledge; the contract per tree piece and the class as a derived label; roles from the request's own frame; step 6 on paper only until S1-2 is read; a slot for retrieve-when-needed on knowledge pieces; how decompose, checklist, decision criteria, acceptance and the loop read it, feeding stored criteria and never rebuilding them.
- **D2 Zero-loss rules per class (Phase 0.3):** what "no value lost" means for an analysis and for a decision memo (drivers, findings, verdict flips, numbers with source and method), stated so code can check it. The unit of loss for an analysis and a memo is the claim (supported-claim share); the Phase 0 baseline and noise band are its test data; it defines the meter's measures.
- **D3 Verdict by requirements (Phase 2; v1.1 G5 admission ledger stays in shadow until its leave-one-domain-out interval clears the noise band):** tiers from requirement outcomes for all three classes; confidence without a model's self-score (judge inflation); how alternatives (OR) satisfy a requirement. Three tiers and demotion; confidence from tier, verified share and family agreement, with an interval; no conformal bound until the label count supports the owner's chosen slack; a slot for prediction-powered estimates (S1-3); one vote per independent family per page.
- **D4 Coverage and stopping (Phase 3; v1.1 G7 rebuilt, with the verified iNEXT incidence formulas):** entity resolution first; the verified incidence formulas as report, then a stop rule on the coverage deficit, with channel independence handled; for a declared space, the settled share and a stop on result sensitivity.
- **D5 Learning (Phase 4; v1.1 G10 two-tier memory, no decay, re-verify on reuse):** loop target from requirement outcomes, itemised verified lessons, reuse per contract without negative transfer; memory-off control in every gate; a slot for pipeline optimisation (S1-7).
A change touching the other machine's files goes there as a patch.

## 5. Every change passes, in order

1. **5-question check** before dispatch: knowledge in code? behaviour on three unrelated research kinds incl. a decision memo? in phase order? evidence from more than one kind of request? and a proof on one research that was not design evidence? defects about logic, not the world?
2. Proven method named with its verified quote; logic ported, no new dependency or egress. Both sides of the method row (fundamental and recent) carry a QC, k/N or M mark, or the change is design only. The quote gate runs before the code, never after. A worker run that returns zero verifiable quotes is a failed run, never a finding: it closes no cell and settles no gap.
3. One mechanism per PR; tests that fail on main; existing expectations changed only with a `test-change:` line.
4. `npm run quality` (integrity, zero-loss union, testsChanged, methods, egress, dependencies) → CI Node 22 and 24.
5. Canary snap → merge → restart → canary compare; a lost clause, criterion or confirmed item = revert.
6. Lessons get ids `F-<date>-<short-name>`.
7. Kept only if, on the meter, value rises and precision does not fall against the noise band of the class; otherwise the flag goes off.

## 6. Keeping the work moving

- At most 4 fcc workers at once; a watchdog kills a worker with no file change for 30 min; attempts end at 45 min; orphans are cleaned at each start.
- Specs are small (one step); the lead finishes a step itself when the worker's diff is right but the model stalls.
- Free providers only for research; any paid fallback is the owner's decision and shows on the waste meter.
- Researches are never asked to stop for an action (E-Q); the owner's actions queue.

## 7. Owner decisions open

- D2 approval, then D1 (B3) approval (revision 4 approved 2026-11-20 with conditions A and B).
- Ask the Mac to push E-Q, fix/router-waste, fix/outside-side-report (E-B is on origin as feat/contract-stages; the Mac rests until the evening of 2026-11-20).
- Paid fallback on the PC runner (Haiku): keep or free lanes only.
- Class-typed cost ratios (discovered: recall-weighted; declared: precision-weighted) and ~30 labels for Phase 2/4 calibration (later).
