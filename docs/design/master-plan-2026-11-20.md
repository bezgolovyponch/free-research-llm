# Master plan — human-line decomposition engine (2026-11-20)

One plan for the owner, the Mac lead (Claude), Fable 5.2 (PC lead) and the fcc workers on both machines. It replaces every earlier list. Item names below are the only names used.

## 1. The logic we implement (the human line)

A careful human researcher works in this order, and the engine follows it, each step proposed by a model and decided by code:

1. **Purpose** — why the asker wants this (from their words; quoted, or labelled "derived").
2. **Contract** — what is delivered: a list of items, an analysis (data, trend, forecast, causes), or a decision; its unit and output format.
3. **Requirements** — what must hold (AND), each traced to the asker's words; implicit ones stated and labelled "derived".
4. **Alternative means** — ways each requirement can be met (OR), found on pages, never imagined by a model.
5. **Roles** — actors and places with their role (location, origin, delivery, place of use).
6. **Domain knowledge** — what the researcher must know to judge (prices, norms, terms, trends), gathered by its own pieces.
7. **Research path** — tree pieces, each naming the requirement it serves.
8. **Evidence** — code reads pages; every value carries a quote found on the decoded page; numbers recomputed by code.
9. **Verdict** — sorted by the requirements (meets every must-have / to confirm / rejected), with coverage and confidence stated; never asks the owner for what sources can establish.
10. **Learning** — verified outcomes improve later researches of the same contract; nothing learned from a model's word alone.

## 2. Method basis (verified quotes live in src/research/methods.json and docs/design/methods-baseline.md)

| Step | Fundamental (verified) | Recent LLM evidence (verified) | Use |
|---|---|---|---|
| 1–5 request model | Zave & Jackson K,S⊢R (M7); KAOS AND/OR refinement (M2); GQM purpose/viewpoint/context (M8); iStar roles | LLM goal extraction F1 0.61–0.76, best as an accelerator (M9); implicit requirements are the main agent failure (M10) | model proposes the model, code checks quotes and trace; a second family reviews |
| 2 contract | systematic review stages (PRISMA, FOUNDATIONS) for lists only | Fable v2: product = decision memo, lists one class | routes stages by class (E-A merged) |
| 4 alternative means | KAOS OR-refinement (M2) | grounded expansion from pages, not model memory (LLM-Modulo M6) | pages name alternatives |
| 8 evidence | wrapper induction | LLM-Modulo (M6); checklists TICK (M11); early pruning (M14) | code first, judge only what code cannot measure |
| 9 verdict | ELECTRE TRI-nB sorting (M1) | rubric judges are noisy, batching trades accuracy (M11); judge relevance inflation (arXiv 2602.17170, PC-verified) | tiers by requirements; confidence never from a model's own score |
| 9 coverage | Chao2 / Chao–Jost incidence coverage (Chao 1987; Chao & Colwell 2017; Chao et al. 2014 — quotes verified on PC) | completeness is the dominant failure of wide search (WideSearch, reference) | report floor + coverage deficit; stop rule only after Phase 1 |
| cost | plan once (M13) | early stopping of votes −58% calls (M12); plan caching (M13) | fewer, earlier, cheaper calls |
| 10 learning | case-based reasoning | GEPA reflective evolution, ACE itemised playbook (M15) | lessons as items with counters, verified tier only |
| eval | regression testing; canary analysis (SRE) | negative flips (CVPR'21, ACL'21); error bars (M16); evaluator locking | zero-loss union per class, canary, integrity |

Pending, nothing built until read by the lead and the owner: **S1** (prediction-powered inference, conformal bounds, claim factuality, domain-knowledge structure, pipeline optimisation, retrieve-when-needed, entity resolution) and **S2** (2024–2026 time and token savers). Both on the PC.

## 3. Phases (each starts only when the previous exit holds)

| Phase | Content | Exit |
|---|---|---|
| **0 Foundation** | E-A contract class (merged #242); E-B analysis skips item-only stages; E-C tree-clearing cause; 0.2 a version rebuild reproduces stored verdicts (pre-merge); 0.3 zero-loss union over classes (list + analysis/memo rules); E-Q action queue (no "stop it first"); P0 quote-on-page core | an analysis research runs end to end; list researches unchanged (zero-loss 0 flips, canary clean) |
| **1 Request model** | D1 design by Fable (owner review) → B3.1 purpose + requirements + trace (`serves`) for all classes → B3.2 roles (was B2) → B3.3 knowledge pieces get sources (was B1) → B3.4 alternative means (OR) | three unrelated researches (plots, freight, action plan) get a correct model on paper and in replay; stored criteria never rebuilt |
| **2 Evidence & verdict** | P2 quote integrity (adds matches only); verdict sorted by requirements; P3 climate index optional; code answers clauses a criterion measures (B5 merged) | headline = items meeting every must-have; memo numbers carry source + method |
| **3 Coverage & cost** | P4 coverage figures (report only) → stop rule; adaptive second opinions (M12); waste meter actions; router waste (R) | calls per valid result not higher; coverage stated in every list memo |
| **4 Learning** | loop target = requirement outcomes + zero-loss; itemised lessons (verified only); plan reuse per contract | loop keeps changes on all three classes |
| **5 Composition & fields** | fields from the request's own frame (P1 returns here), composed results from confirmed fields only | no knowledge in code (5-question check) |

## 4. Who does what (revision 1: Fable designs the logic; both fcc lanes implement)

| Role | Owns | Does |
|---|---|---|
| **Owner** | priorities, labels, cost ratio, approvals | approves each design before its code starts, and every phase exit |
| **Fable 5.2 (PC) — logic designer** | the engine's reasoning design | writes the designs below, each with the 5-question check, a walk-through on three unrelated stored researches (plots b7772e list, freight 3c9f1f analysis, action plan fc04bd decision), the verified method behind each rule, and the smallest first PR with its zero-loss proof; validates P-packages; runs S1/S2 |
| **Mac lead (Claude)** | the plan, dispatch, review, merges, canary | turns an approved design into one-step fcc specs, reads every diff and real output, merges with the canary; harness and infrastructure |
| **Mac fcc** (NVIDIA keys 2, 3) | engine.mjs routing, deliverable.mjs, server/action queue, router, proposal/index.html, harness scripts | implements specs |
| **PC fcc** | quote.mjs, acceptance.mjs, listings.mjs, cci.mjs | implements specs |

**Fable's prior work is the starting point, not a blank page.** Fable has already reviewed and combined the methods: the engine methods design v1, v1.1 dispositions on the external audit and the lead's review (28 rows: keep / accept / replace / reject, with a constants register), the engine design v2 decision (order: memo baseline, meter, quote-on-page tiers, case retrieval, fields later), and the wave-1 measurements on stored data (W1-A admission, W1-B case retrieval, W1-C fields, W1-D coverage, W1-F labels, W1-H harness). Each design below continues that work: it reuses what v1.1/v2 settled, states what changes and why, and keeps the dispositions' rules (no hand cuts — weights instead; pages name alternatives, never the model; verified vs admitted tiers; parity per valid result). Those documents are copied to docs/design/ on main so both machines read the same text.

Designs owned by Fable, in phase order (each: ≤ 4 pages, no code; continuing v1.1/v2):
- **D1 Request model (Phase 1, next; extends v2's frame/contract step and v1.1 G2 class → member → service → outcome):** purpose, contract, requirements (AND) traced to the asker's words, derived implicit requirements, alternative means (OR) found on pages, roles, domain knowledge; how decompose, checklist, decision criteria, acceptance and the loop read it, feeding stored criteria and never rebuilding them.
- **D2 Zero-loss rules per class (Phase 0.3):** what "no value lost" means for an analysis and for a decision memo (drivers, findings, verdict flips, numbers with source and method), stated so code can check it.
- **D3 Verdict by requirements (Phase 2; v1.1 G5 admission ledger stays in shadow until ≥ 200 owner labels):** tiers from requirement outcomes for all three classes; confidence without a model's self-score (judge inflation); how alternatives (OR) satisfy a requirement.
- **D4 Coverage and stopping (Phase 3; v1.1 G7 rebuilt, with the verified iNEXT incidence formulas):** the verified incidence formulas as report, then a stop rule on the coverage deficit, with channel independence handled.
- **D5 Learning (Phase 4; v1.1 G10 two-tier memory, no decay, re-verify on reuse):** loop target from requirement outcomes, itemised verified lessons, reuse per contract without negative transfer.
A change touching the other machine's files goes there as a patch.

## 5. Every change passes, in order

1. **5-question check** before dispatch: knowledge in code? behaviour on three unrelated research kinds incl. a decision memo? in phase order? evidence from more than one kind of request? defects about logic, not the world?
2. Proven method named with its verified quote; logic ported, no new dependency or egress.
3. One mechanism per PR; tests that fail on main; existing expectations changed only with a `test-change:` line.
4. `npm run quality` (integrity, zero-loss union, testsChanged, methods, egress, dependencies) → CI Node 22 and 24.
5. Canary snap → merge → restart → canary compare; a lost clause, criterion or confirmed item = revert.
6. Lessons get ids `F-<date>-<short-name>`.

## 6. Keeping the work moving

- At most 4 fcc workers at once; a watchdog kills a worker with no file change for 30 min; attempts end at 45 min; orphans are cleaned at each start.
- Specs are small (one step); the lead finishes a step itself when the worker's diff is right but the model stalls.
- Free providers only for research; any paid fallback is the owner's decision and shows on the waste meter.
- Researches are never asked to stop for an action (E-Q); the owner's actions queue.

## 7. Owner decisions open

- B3 design approval (next).
- Paid fallback on the PC runner (Haiku): keep or free lanes only.
- Cost ratio and ~30 labels for Phase 2/4 calibration (later).
