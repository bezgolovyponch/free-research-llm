# AUDIT — from FREECC (tour-business calibration) to Free Research LLM

Audited inputs: `~/Documents/freecc/` (README, ISSUE-TREE, PLAYBOOK, EVIDENCE, REPORT, `cascade/`, `router/`, `prompts/P0–P8`, `gates/`) and `~/Documents/mmmlll.html` ("FREECC — Decomposition & Agent UI"), both dated 2026-10-17.

Goal they were measured against: **any analytical issue** (cars arbitrage, glamping location, taxes, …) should go from one prompt to a researched, checked answer, in an app that is complete, launchable and user-friendly.

## 1. Findings

| # | Finding | Evidence | Effect on the goal |
|---|---|---|---|
| F1 | The root of every tree is hard-wired to the tour business | ISSUE-TREE L0 = "Company expansion → qualified leads → paid bookings to destinations D"; `baselineProject()` in the UI; OQ-1 "destinations not provided" | A car or tax question inherits a bookings/funnel tree |
| F2 | The domain detector is a keyword list for travel marketing | `LEX` in the UI: bookings, leads, destination/SEO content, campaigns, analytics, compliance | "car arbitrage", "glamping", "tax" match nothing (or match by accident: "price" → Payments & Booking) and fall back to a generic *software-delivery* pipeline |
| F3 | The engine is a coding-agent stack, not a research stack | C1–C5 = LiteLLM routing, Claude Code/OpenCode harness, mikoshi-construct, AGENTS.md markers, budget; gates check `pnpm run quality`, ladder constants, role pins | 18 of ~30 nodes in every generated tree are infrastructure issues unrelated to the user's question |
| F4 | No model is ever called from the UI | The generator is deterministic keyword-to-template expansion. "Run SIMULATED gate" turns a node green with a toast | The UI *looks* like research but produces none. Green nodes are not evidence, which breaks its own truth rule 6 in spirit |
| F5 | Gate status is a constant | `GATES=[…{s:"PASS"}]`. The "replay" is an animation of hard-coded rows | It cannot reflect the current machine |
| F6 | The verifier cannot judge analysis | `cascade/core.mjs` verifies `exact` (synthetic TASK tokens), `contains`, or `exec` a shell command | Nothing checks sources, numbers or arithmetic, which is what analytical answers need |
| F7 | Setup is heavy and brittle | Python LiteLLM proxy + mikoshi-construct + Claude Code/OpenCode; hard-coded model IDs (`gemini-3-pro`, `qwen3-coder:free`…) that the README itself says drift monthly | A non-developer cannot launch it, and it breaks silently when IDs change |
| F8 | Keys are expected in a file | `router/.env.example` → `router/.env` with real keys | Conflicts with the rule that secrets live only in the shell environment |
| F9 | Priority is "unlock power" (count of dependents) | `computePriority()` | For a decision, the node worth researching first is the one with the highest **impact × uncertainty** (value of information), not the one with most arrows |
| F10 | Prompts P0–P8 are copy-paste text | `prompts/*.md` + validator that checks headings | Users must run the methodology by hand in another tool |

## 2. What was kept (the parts that are genuinely sound)

| FREECC concept | Where it lives now |
|---|---|
| FrugalGPT-style cascade: cheap first, pay for strength only when verification fails (E6/E7) | `ResearchEngine.researchLeaf`: fast tier → checks → deep tier with the failure list |
| Quota pooling + failover + cooldown (E11–E13) | `ModelRouter`: ordered free providers, 429/5xx cooldown honouring `Retry-After`, bounded wait when all are cooling |
| Three-level budget split | per call: fast tier first · per node: max 2 attempts · per session: paid providers off unless `FRL_PAID_CALL_LIMIT` |
| "The verifier is never the doer" | Independent reviewer on a *different* provider (`avoid`), plus mechanical checks the model cannot override |
| "No claim without a ledger ID" | Every numeric claim must cite a retrieved source id `[S#]`/`D1` or be labelled an assumption; invented ids → **unsupported** |
| "Test the test" / gates as the definition of done | `npm test` (Vitest) covers the router, checks, calculator, tree logic, engine, server and report |
| Open questions are deliverables | per-node `gaps`, memo `openQuestions`, `assumptionsToConfirm` |
| Externalized memory instead of a huge context | the project JSON *is* the memory: each prompt receives only the node, its sources and the answers it depends on |
| Dependency-cloud UI, side panel, critical path thinking | `public/index.html` Tree tab: tidy layout, live status, dashed "needs" edges |

## 3. Redesign: the generic analytical method

```
DECISION (one sentence + success threshold)
  └─ DRIVERS (3-6, mutually exclusive, together exhaustive for the decision)
       └─ SUB-QUESTIONS (2-4 each): hypothesis · metric+unit · method (lookup | calculation |
          comparison | estimate | data) · search queries · dependsOn · impact 1-5 · uncertainty 1-5
```

Domain knowledge is a **template** (a checklist of typical drivers, metrics, sources and a decision rule), not a hard-wired tree. Templates exist for car arbitrage, glamping/hospitality location, taxes and market sizing, plus a generic one. Auto-detect picks one from the wording, and the model adapts it to the actual question.

## 4. Compared against the three real use cases

| Use case | What the analysis really needs | How the app covers it | Residual risk |
|---|---|---|---|
| **Cars arbitrage** DE→PL | Like-for-like spec price gap; full landed cost (transport, excise, registration, inspection, VAT margin scheme); days to sell; fraud risk (mileage, accident history); FX | Template drivers list exactly these. The margin node `dependsOn` both price nodes, so it is researched after them with their numbers, and its formula is recomputed. Listing CSVs become source D1 with medians and percentiles | Live listing prices are rarely on Wikipedia. Use Tavily, or upload a scrape/export as CSV |
| **Glamping location** | Overnight-stay demand per region; achievable ADR and occupancy from comparables; land and permits (protected areas); capex/opex; payback sensitivity | Drivers + decision rule "rank by risk-adjusted payback". The memo's *sensitivity* section names the occupancy level that flips GO→NO-GO | Permit feasibility needs municipal sources. Weak nodes flag it, they do not settle it |
| **Taxes** | Current-year rates and thresholds per regime; eligibility conditions; social + health contributions; computed total burden | Calculation nodes with formulas recomputed by machine. "high" confidence needs 2+ independent domains. The memo carries the "not legal advice" rule | Year-specific rates must come from official sources. A free model's prior knowledge is labelled as an assumption and graded weak |

## 5. Tests and verification

- `npm test`: **58 tests pass**. Covered: calculator, JSON extraction, tree normalisation/ordering/cycles, every check and grade, CSV profiling, provider discovery/JSON-mode fallback/429 handling, router failover/repair/cooldown wait/paid cap, all four search backends (stubbed HTTP), the engine end to end (decompose, research, escalation, roll-up, memo, failure isolation, CSV source, edit/expand/add/remove, cancel, concurrency guard), the HTTP server (UI, SSE, background run, Markdown export, errors) and composition.
- The tests caught four real bugs during the build, all fixed: concurrent saves collided on one temp file; two runs could start in the same tick; a single-provider setup aborted on any 5xx instead of waiting out the cooldown; and roll-ups of verified children were graded lower than their children.
- Demo-mode runs against live Wikipedia succeeded end to end (12 nodes, memo written).
- **Not yet done:** a run against a real LLM on this machine. No provider was connected during the build (the user chose "build only, test later"). First live step: export a Groq or Gemini key, `npm start`, and run one example per template.

## 6. What would falsify this design

- If on real models more than half the leaves end **weak** even with Tavily enabled, the research prompt or the search queries are the bottleneck. Inspect the failing checks per node in the UI before changing models.
- If **verified** nodes are later found wrong, the checks are too lenient. The next step is claim-to-source quote matching: require a verbatim snippet per claim and check it against the fetched text.
