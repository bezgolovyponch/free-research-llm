# Alternative means of one purpose goal (OR-refinement) — design for after C1–C12 merge

Owner, 2026-11-18 (plots b7772e, an example of the logic, not a hard rule): plots that had the sea within ~7 km OR valuable landscapes and sights around them (a nice view) both served the purpose. "This has to come from the purpose logic."

## Kind of logic
Means–ends reasoning with OR-refinement. Ask WHY the asker wants a requirement (sea nearby) → the end it serves (guests choose the place for its natural setting and things to see). A requirement that is a MEANS to an end can be met by alternative means; any one of them satisfies the end.
- van Lamsweerde, "Goal-Oriented Requirements Engineering: A Guided Tour", RE'01 (open PDF https://webperso.info.ucl.ac.be/~avl/files/RE01.pdf), verified quote: "OR-refinement links relate a goal to an alternative set of refinements; this means that satisfying one of the refinements is sufficient for satisfying the parent goal." Parent goals are found by a WHY question (same paper).
- Keeney, Value-Focused Thinking (1992): means objectives vs fundamental objectives, separated by asking "why is this important?"; a means objective matters only through the fundamental objective it serves (summary sources, book not open access).
- LLM evidence: Sharfuddin & Breaux, "Generative Goal Modeling", arXiv 2509.01048 (RE 2025), verified abstract: "GPT-4o generates goal model refinement relationships among extracted goals with 72.2% accuracy." → a model can propose refinement links, but ~1 in 4 is wrong: proposals are voted by independent families (#212) and shown to the owner, never silently applied.

## Gap in the live engine (main 123fed0)
- src/research/purpose.mjs:452–455 already asks for "refine": "AND" | "OR" — but purpose.mjs is replay-only since #210; the live decision model, checklist (checklist.mjs) and verdict (verdict.mjs) hold only a flat AND of criteria. No criterion group can be met by alternatives.
- The data for the alternative already exists per plot: decision.mjs:38 measure explorePoints (beaches, viewpoints, sights, reserves, trails within 15 km), used only for ranking in strategy.mjs:294/380.
- Same gap elsewhere (check during design): suppliers "brands similar to Ralph Lauren, Moncler, North Face, Barbour" is a class with alternatives (any brand of that class), currently judged as one clause; cars "hatchback" is a body type with near-equivalents only if the purpose allows — the vote decides, the owner confirms.

## Change (reuse, no new layer — F54)
1. Decision model criteria gain an optional group: { goal, why, refine: 'OR', alternatives: [criterion…], source: asked|derived }. The asker's own requirement stays one alternative and stays hard as a GROUP: the group vetoes only when every alternative fails.
2. Alternatives are proposed from the purpose by the existing refine prompt (purpose.mjs:452), voted by independent families (#212 closedVote), each bound to an existing code measure (explorePoints, coastKm, …) with a threshold sourced from the asker, a cited note, or labelled "derived" (C1 rule). No site names, no domain words in engine code.
3. Checklist and verdict: an OR group is "yes" if any alternative is yes, "no" only if all are no, else "unknown"; the quote names which alternative held.
4. The owner sees each group (goal, why, alternatives, source) and can remove an alternative (EvalGen criteria drift).
5. Zero value loss (same 8 conditions as C1–C12): replay on stored b7772e, 0c750f, b2f5b7 — wrong confirmed not higher (labels), right confirmed not lower, eligible lost 0, must-have counts not lower (a group counts as one must-have), verdictInvariants empty.
