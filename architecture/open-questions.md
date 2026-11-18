# Open questions

These look like conventions but the codebase is not consistently applied. Confirm before treating
them as rules. Read this file when a task touches one of them; it is not loaded into every session.

<!-- construct:discover:open-questions -->
1. **Dependency boundaries between research layers** — `src/research/` imports from `src/llm/`, `src/search/`, `src/data/`, but the reverse is not enforced by lint. The only enforced boundary is `verifier/` → `src/` (quality gate `independence`). Other boundaries are architectural convention.

2. **ESLint configuration** — The repo uses `@antfu/eslint-config` with TypeScript, but some `.mjs` files use ESM imports while `.ts` files use different conventions. The harness runs `eslint .` but the current config may not pass on all source files without fixes. Either make ESLint pass on current code or remove it from the harness and record here.

3. **Test file naming** — Tests live in `tests/**` mirroring `src/**` as `*.test.ts`, but some modules in `scripts/` have tests in `scripts/tests/**`. The `testsPresent` gate checks `src/` and `verifier/` modules only.

4. **Hard-coded strings in engine** — Some error messages and log strings in `src/research/engine.mjs` and `src/research/checklist.mjs` contain domain-specific words (e.g., "glamping", "plot", "supplier") that should be generic. These are being removed incrementally (F25).

5. **VERSION constant migrations** — `DECISION_MODEL_VERSION`, `CHECKLIST_VERSION`, `JUDGE_VERSION`, `TREE_VERSION` are bumped when the shape changes, but old stored researches may not migrate cleanly. The `fresh()` check in `DecisionModeler` handles some cases, but not all.

6. **Offline baseline rebuild** — The `reference-baseline` gate reads stored `decisionModel` shapes from fixtures. A full offline rebuild (running the decision modeler with stubbed router) is not yet implemented; the current check validates the stored shape directly. If a full rebuild becomes possible, the gate should be upgraded.
<!-- /construct:discover:open-questions -->

- Construct preset parts not adopted on 2026-11-18 (FRL is npm + plain ESM JS, no TS): HTTP contract (openapi), composition models, ESLint, tsconfig. Adopt one at a time only with its harness check passing.
- Reference-baseline gate (criteria and hard-check counts on b2f5b7, 0c750f, b7772e never drop): baseline numbers come from the post-revert reruns on main 476f279, measured from real stored projects — not hand-written.
