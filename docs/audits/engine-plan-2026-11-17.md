# Engine plan from the 2026-11-17 audits

Two audits written by Claude Fable 5.2 and checked by the lead:
- `engine-sources-and-methods-2026-11-17.md`: about 90 cited sources verified (26 need a correction or a decision), and current methods for seven areas.
- `engine-logic-and-maintainability-2026-11-17.md`: dependency map, stage order, contracts, constants, maintainability (2.2 of 5), output shape, scope, universality.

The lead re-checked two load-bearing claims in the code:
- The purpose stages (`scoping`, `purpose`, `facts`, `ach`, `embedder`) are imported only by `scripts/purpose-replay.mjs` and by each other.
- `vote()` reaches its quorum from two identical replies whatever provider gave them; `avoid` is only a preference.

## Waves (each wave merges only through `npm run quality`, CI on Node 22/24, and a produced tree or result read by the lead)

| Wave | Content | Source |
|---|---|---|
| 1a | Repair `feat/crucial-factors`:<br>• break the import cycle (`roles.mjs`, `admiralty.mjs`, `clausesOf` out of `strategy.mjs`);<br>• keep main's coverage rule and `drawn`;<br>• role-aware `relevanceReason` and requirement-aware `screeningSubject` in the targeted round;<br>• one against one = open.<br>Then order: merge duplicates → critique → refine → factors. Citation corrections in the specs and lessons. | B §2.4, plan 1 and 6; A §1.1 |
| 1b | Measurement and vote integrity:<br>• a vote counts only independent provider families (otherwise `single`);<br>• option letters rotated, not shuffled, with a per-model letter-frequency check;<br>• a reference set of labelled judgements on a fixed page corpus (labelled by the strong model, spot-checked by the owner);<br>• κ per task and provider;<br>• paired comparison with bootstrap intervals;<br>• three runs per replay;<br>• the judge baseline (wrong-no rate). | B plan 2, §8.3; A changes 1 and 9 |
| 2 | Judge and hardness:<br>• judge with the embedder;<br>• kind first, stop on a kind "no";<br>• a hard "no" needs a second family;<br>• outcomes recorded under a `checklist` class;<br>• one owner of check ids;<br>• hardness by a closed vote per requirement plus the user's confirmation;<br>• cue words, `HARD_SEA_KM` and `HARD_CAMPING_MONTHS` removed. | B plan 3 and 4 |
| 3 | Live wiring in the recommended order (B §2.5), with:<br>• `needs-confirmation` and `confirmTree`;<br>• checklist from the tree plus a 12-item probe;<br>• pieces only for questions the judge and the table cannot answer;<br>• memo after the verdict;<br>• the five legacy scoping stages deleted as each is replaced. | B plan 5 and 7; TREE-BRIEF |
| 4 | Output shape from the tree:<br>• a closed vote on the result shape;<br>• columns = the tree's determinant factors and asked constraints;<br>• Pareto layers inside a tier;<br>• memo sections per goal.<br>Research-type content moved out of `src/` into data packs; the lexical checks U1 to U9 replaced. | B plan 8 and 9, §7.2; A area 5 (ArxivDIGESTables, DecisionFlow) |
| 5 | Efficiency, each accepted only on the paired comparison:<br>• one vote where a provider's measured record is long and high (full vote on a random tenth and on every veto);<br>• dense plus sparse rank fusion with a free reranker;<br>• next-round queries from kept facts (IRCoT);<br>• refine a question only when its judged answers are mostly unknown (ADaPT);<br>• rank stability over weight vectors;<br>• correlated factors share one weight;<br>• constants with a stated basis;<br>• offline prompt optimisation of the closed votes (GEPA) against the reference set. | A changes 2 to 8 and 10; B plan 10 |

After wave 3, the China white-label test research and the stag archive are re-run on the live path.

## Not adopted, with reason (A)
- **Self-RAG, Adaptive-RAG and RouteLLM:** they need trained models or classifiers.
- **FLARE:** it needs token confidences that free routes do not return.
- **Semantic caching:** its similarity threshold breaks rule R5.
- **Supervisor and worker agent layers:** the benchmarks find no gain and LocationReasoner finds a loss.
- **TextGrad:** it depends on a strong feedback model in the loop.
- **MiniCheck:** not adopted until it is measured on the reference set (it is trained on English).
