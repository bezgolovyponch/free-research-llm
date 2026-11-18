<!-- construct:begin -->
# construct

Context for coding agents and automated reviewers working on construct. This repository runs on a
construct materialized by `mikoshi-construct` v0.46.0: architecture policy in
[architecture/](architecture/), a harness that proves every change, and the rules that apply to all
code in [architecture/principles.md](architecture/principles.md). What follows is what is specific to
this repository. Sections marked "not discovered yet" are filled by construct discovery
(`/construct-discover` in Claude Code, "run construct discovery" in Cursor), then kept current by
whoever changes the thing they describe.

## What this product does

<!-- construct:discover:product -->
Free Research LLM answers one decision question with a researched, machine-checked answer using only free model and search quotas. It runs on your own computer (macOS, Windows, Linux) or a free cloud VM. The one rule: a model can propose, but only code decides what counts as a result. Grades, delivered links, calculations and "done" messages come from mechanical checks, never from what a model says about itself.

The highest-cost defect flow is the **list research acceptance pipeline** (CONCEPT.md §4m, PROTOCOLS.md §4m): if the candidate table, item gate, checklist verdict or memo check diverge, the user gets a wrong count of valid items — money, identity or data decisions rely on this number. The invariant is that validity is computed in exactly one place (src/research/verdict.mjs) and every path calls it.
<!-- /construct:discover:product -->

## Module map

<!-- construct:discover:module-map -->
| Path | Purpose |
|------|---------|
| src/server.mjs | HTTP server, routes, auth, terminal sockets, event streams |
| src/app.mjs | Core app: engine, store, router, search, terminal, history, logs |
| src/frl.mjs | CLI entry: start, keys, local models, changes, terminal, install |
| src/llm/router.mjs | Model routing, tiered selection, provider outcomes, bench/restore |
| src/llm/provider.mjs | Provider implementations (Groq, Gemini, Cohere, etc.) |
| src/llm/ranking.mjs | Thompson sampling, posterior updates, wait-time accounting |
| src/llm/outcomes.mjs | Per-model outcome book, Beta posteriors, arm keys |
| src/llm/embedder.mjs | Embedding vectors, caching, medoid/rank |
| src/research/engine.mjs | Research orchestration: tree, sweep, acceptance, loop, lanes |
| src/research/decision.mjs | Decision model: criteria from clauses, kind calibration, cases |
| src/research/checklist.mjs | Per-item checklist from the decision model criteria, judge, hard/soft |
| src/research/verdict.mjs | Single owner of item validity: tier, belief, verdict text |
| src/research/acceptance.mjs | Expected-result checks: count, live, range, kind, checklist |
| src/research/purpose.mjs | Purpose tree: goals, tensions, value/cost sides, traceability |
| src/research/scoping.mjs | Arksey & O'Malley scoping: perspectives, queries, roles |
| src/research/brief.mjs | Concept brief: kind, regions, sea, exclusions, located flag |
| src/research/sweep.mjs | Portal sweep: Thompson sampling, recipes, page reading |
| src/research/candidates.mjs | Candidate table: screen, tiers, strategy, site fit, verifier |
| src/research/tree.mjs | Issue tree: decompose, normalize, repair, progress, order |
| src/research/verify.mjs | Gate protocol: citations, calculation, concrete, numbers |
| src/research/support.mjs | Meaning check: two-vote attribution, resolve from sources |
| src/research/evidence.mjs | BM25 passages, MMR, diverse order, retrieval verdict |
| src/research/improve.mjs | Self-improving loop: trials, regression gate, merge |
| src/research/strategy.mjs | Strategy cases: glamping rules, retrieval, verification |
| src/research/valuecase.mjs | Owner/expert consensus: MIN_AGREEING_SITES, merge |
| src/research/valuation.mjs | Car value: hedonic, comparables, jackknife interval |
| src/research/concept.mjs | Kind validation: umbrella, concept card, grounded terms |
| src/research/grounding.mjs | Criteria from user text only, drop inferred |
| src/research/itemgate.mjs | Screen deliverables: kind, listing URL, price range |
| src/research/deeper.mjs | Deeper reads for unknown hard checks, budget |
| src/research/blockers.mjs | Legal blockers, lease without owning, result nature |
| src/research/lease.mjs | Lease feasibility: payback, horizon, revenue share |
| src/research/verify.mjs | Gate protocol checks |
| src/research/result.mjs | Provisional verdict, memo, action plan |
| src/search/selection.mjs | Source ranking: MMR, entities, domains, used domains |
| src/search/listings.mjs | JSON-LD, embedded JSON, listing cards, recipes |
| src/search/schema.mjs | Schema learning, CSS selectors, weekly re-check |
| src/search/browser.mjs | Playwright headless render, shared browser |
| src/chat/reply-audit.mjs | Links, secrets, commands, placeholders, claims |
| src/chat/thread.mjs | Piece, research, results, app chats with scope |
| src/coder/free-coder.mjs | Sandbox edits, quality gate, backup/undo |
| src/coder/claude-coder.mjs | Claude Code integration for app changes |
| src/store.mjs | Project store: save, snapshots, journal, LRU cache |
| src/journal.mjs | Append-only journal of every piece/row change |
| src/secrets.mjs | Keychain, Windows env, Linux secret-tool, systemd |
| src/auth.mjs | Access gate, shares, loopback, cross-origin, foreign host |
| src/events.mjs | Batched live updates, backpressure, dead peer detection |
| src/workbook.mjs | Excel export: sheets, hyperlinks, sortable columns |
| src/report.mjs | Markdown, CSV, JSON, ZIP export |
| scripts/quality.mjs | Harness: syntax, workflows, independence, secrets, noComments, testsPresent, e2e, flakes, tests |
| scripts/composition/check.ts | Composition model validation |
| scripts/composition/sync-docs.ts | Render architecture diagrams |
| scripts/construct/check-baseline.mjs | Reference baseline check (to be added) |
| scripts/process-lessons.json | 52 lessons (F1–F53) with signals, causes, prevention |
<!-- /construct:discover:module-map -->

## Commands

<!-- construct:discover:commands -->
```bash
npm run quality      # the harness: syntax, workflows, verifier independence, secrets, noComments, testsPresent, e2e, flakes, tests — the CI gate and the agent gate
npm run dev          # run the service locally with tsx watch on src/server.ts
npm run start        # run the service locally with node src/server.mjs
npm run demo         # run in demo mode (scripted answers, not real research)
npm run ask          # CLI: ask a question directly
npm run test         # run vitest
npm run check        # syntax check + vitest run
npm run lint         # ESLint check
npm run lint:fix     # ESLint with --fix; ESLint is the only formatter
npm run typecheck    # TypeScript noEmit check
npm run e2e          # Playwright tests on iPhone 14 (WebKit) and Pixel 7 (Chromium)
npm run hooks        # activate .githooks/pre-commit (runs npm run quality)
```

<!-- /construct:discover:commands -->

## Harness

`npm run quality` is the gate for any change. A change is not done until it passes; a pass is
reported by the harness, never by the implementer. Security invariants and the check that enforces
each one: [architecture/security-invariants.md](architecture/security-invariants.md).

## Contract

No HTTP contract file yet: the API is defined by src/server.mjs routes and covered by e2e. Recorded in architecture/open-questions.md.

## Architecture

The principles in [architecture/principles.md](architecture/principles.md) apply; this is how they map
here.

- *Composition roots.*
  <!-- construct:discover:composition-roots -->
  - **src/server.mjs** — `createServer(app, gate)` mounts all HTTP routes, SSE, terminal WebSockets, vendor assets, share links, and exported reports. The `routes` array is the single place to add a new endpoint: each entry is `[method, pattern, handler]`. Rule: add a route by pushing to `routes` before `createServer` returns; never mount handlers outside this array.
  - **src/app.mjs** — `App` constructor wires the research engine, store, router, search, terminal, coder, improver, handoffs, logs, history, peers, watchdog, housekeeping, and the app chat. Rule: a new service is constructed here and passed to `createServer` via the `app` instance; the engine, router, search, store are the only ones the server routes touch directly.
  - **src/frl.mjs** — CLI entry constructs `App` and calls `startServer`. Rule: operational commands (keys, local, change, terminal, install, restart) are subcommands here; they reuse the `App` instance from `src/app.mjs`.
  - **src/coder/free-coder.mjs** / **src/coder/claude-coder.mjs** — Sandbox execution for app change tickets. Rule: the coder only writes to `data/work/C<n>/` and runs `npm run quality` there; it never touches the live app directly.
  - **verifier/verify.mjs** — External verifier process (separate Node process, no `src/` imports). Rule: it reads `data/verification/<id>.jsonl` and writes its own records; the app spawns it via `verifier.run()`.
  <!-- /construct:discover:composition-roots -->
- *Dependency policy.*
  <!-- construct:discover:dependency-policy -->
  - **verifier/** must not import from `src/` — enforced by `scripts/quality.mjs` gate `independence` (checks for `import.*\.\.\/src\/` in verifier files). The verifier is a separate process with its own `package.json` scope.
  - **src/llm/** (router, provider, ranking, outcomes, embedder) — no imports from `src/research/`, `src/chat/`, `src/coder/`. The LLM layer is a pure provider abstraction.
  - **src/research/** — may import from `src/llm/`, `src/search/`, `src/data/`, `src/chat/` (for reply-audit types), but not from `src/coder/`, `src/terminal/`, `src/app.mjs` (circular). The engine is the composition root for research logic.
  - **src/search/** — no imports from `src/research/`, `src/chat/`, `src/coder/`. Pure search and extraction.
  - **src/chat/** — may import from `src/research/` (for piece/node types), `src/llm/` (for router in reply-audit), but not from `src/coder/`, `src/terminal/`.
  - **src/coder/** — may import from `src/` for types only; executes in a sandbox copy (`data/work/C<n>/`).
  - **src/terminal/**, **src/local/**, **src/data/** — leaf modules, no inward dependencies from research/chat/coder.
  - **Rule for adding a new module**: place it in the correct layer (llm, search, research, chat, coder, terminal, local, data). If it needs to call another layer, the dependency must follow the arrows above. The `scripts/quality.mjs` gate `independence` only checks verifier→src; other boundaries are architectural convention (record in open-questions.md if unclear).
  <!-- /construct:discover:dependency-policy -->
- *Composition models* and their rendered diagrams: [architecture/composition/](architecture/composition/).

## Reasoning budget

High-effort areas — a task that touches one of these is classified `high` and designed before it is
implemented (see `/implement`):

<!-- construct:discover:high-effort-areas -->
- **src/research/decision.mjs** — Decision model: criteria from clauses, kind calibration, case bank, aggregate across 3 proposals, rebuild guards. A wrong change loses criteria or accepts degenerate models (F27).
- **src/research/checklist.mjs** — Per-item checklist from the decision model criteria: judge, hard/soft, clustering by meaning, quote binding. A wrong change makes every item fail or pass incorrectly (F24, F28–F31).
- **src/research/verdict.mjs** — Single owner of item validity: tier, belief, verdict text, invariants. A wrong change diverges memo from table (F33, F34).
- **src/research/acceptance.mjs** — Expected-result checks: count, live, range, kind, checklist, evaluate. A wrong change reports wrong valid count (F26, F40).
- **src/research/purpose.mjs** — Purpose tree: goals, tensions, value/cost sides, traceability, thresholds, hardness vote. A wrong change invents numbers, drops clauses, misclassifies hard/soft (F35–F38, F41, F47).
- **src/research/engine.mjs** — `checkAcceptance` (orchestrates sweep, judge, deeper, verdict, memo) and `decompose` (tree, decision model). A wrong change skips stages or calls wrong modeler (F27, F44, F46).
- **Any *_VERSION constant** — `DECISION_MODEL_VERSION` (6), `CHECKLIST_VERSION` (4), `JUDGE_VERSION` (4), `TREE_VERSION` (4), `PURPOSE_STAGE`, `TREE_STAGE`. Bumping without migration loses stored researches.
- **scripts/process-lessons.json** — 52 lessons (F1–F53) encoding every defect class. A change here must reflect a real root cause, not a symptom patch.
- **src/llm/router.mjs** — Model routing, scoped calls, wait events, bench/restore, payment exclusion. A wrong change stalls research or burns quota (F6, F20, F43, F53).
- **src/llm/ranking.mjs** — Thompson sampling, posterior per model|purpose, wait-time in spentMs. A wrong change starves better providers (F20, F53).
- **src/research/scoping.mjs** — Arksey & O'Malley scoping: perspectives, roles, host diversity, replay inputs. A wrong change drops knowledge sources (F42).
- **src/research/strategy.mjs** — Strategy cases (glamping), retrieval, verification, trend in buyer currency. A wrong change mis-measures sea/climate/trend (F51).
- **src/research/sweep.mjs** / **src/research/candidates.mjs** — Portal sweep, candidate table, screen, tiers, site fit, verifier merge. A wrong change loses valid rows or keeps junk (F12, F13, F18, F19).
- **src/research/valuecase.mjs** / **src/research/valuation.mjs** — Owner/expert consensus, hedonic car value, jackknife interval. A wrong change accepts unverified facts (F15).
- **src/research/concept.mjs** — Umbrella kind validation, concept card, grounded terms. A wrong change narrows a category to one kind (F32).
- **src/research/improve.mjs** — Self-improving loop: trials, regression gate, merge, kept-data, plateau. A wrong change stops early or reverts gains (F16, F17, F22).
- **scripts/quality.mjs** — Harness gates: syntax, workflows, independence, secrets, noComments, testsPresent, e2e, flakes, tests. A change here must keep all gates green.
<!-- /construct:discover:high-effort-areas -->

Always high, whatever discovery finds: [contracts/api/openapi.yaml](contracts/api/openapi.yaml),
`architecture/composition/`, `eslint.config.mjs`, and every row of
[architecture/security-invariants.md](architecture/security-invariants.md).

## Conventions the harness does not enforce

No comments in source (functional pragmas such as `eslint-disable*` and `@ts-expect-error` are
compiler input and are never removed). `async`/`await` over promise chains where the enclosing context
can be async. Tests live in `tests/**` as `*.test.ts`, never beside the source, and every new or
changed logic module ships its test in the same change. ESLint is the only formatter.

## Real defects vs accepted variance

Treat as real defects:

- A new or changed logic module with no test file.
- A response shape that drifts from the API contract, or a breaking change to a `/v1` endpoint that
  was not identified deliberately.
- A secret, API key or connection string written into any file. Config references the environment.
- Any row of [architecture/security-invariants.md](architecture/security-invariants.md) that a change
  weakens.

<!-- construct:discover:defects-vs-variance -->
Additionally, treat as real defects (from process-lessons.json and live audits):

1. **Criteria loss on reference research**: A change that lowers the number of decision criteria or hard (vetoing) checks on a reference research (b2f5b7 suppliers, 0c750f cars, b7772e plots). The baseline is `tests/fixtures/reference/baseline.json` — criteria count and hard-check count must not decrease.

2. **Confirmed rise with fewer hard checks**: A rise in "confirmed" items while the number of hard checks passing has decreased. This indicates the verdict logic widened validity instead of the evidence improving (F33, F34).

3. **Claim without raw output**: A worker/implementer claim not backed by raw output (model call logs, search results, fetched page text, verification record). Every claim in a PR must cite the log line or fixture it came from.

4. **Domain words in engine code**: Hard-coded host names (europages, kompass, wllw.net, visable), kind labels (wholesale, car, supplier, plot, glamping), or per-research rules in `src/research/`, `src/search/`, `src/llm/`. The engine is universal — specifics come from the question, schema.org/JSON-LD, or learned app data (F25).

5. **Symptom patch without engine cause**: Fixing a symptom (e.g., "added a check for X") without addressing the engine cause (why the checklist or decision model allowed it). Every fix must trace to a decision model criterion or checklist item (F21, F45).

6. **Stale stored decision model**: A change that records a degenerate decision model (no kind, no criteria) as a case and pollutes future researches (F27). The `isDegenerate` guard in `DecisionModeler.build` must reject such models.

7. **Acceptance without checklist**: `acceptance.itemCount` set but `decisionModel.checklist` is empty — caught by `verdictInvariants` (F26, F40).

8. **Memo/acceptance divergence**: The memo text says one count while `acceptanceSummaryOf` computes another — caught by `verdictInvariants` memo check (F40, F45).
<!-- /construct:discover:defects-vs-variance -->

Treat as accepted variance and do not report: formatting, quoting and import order (ESLint owns
them); the `.js` suffix on relative TypeScript imports (NodeNext ESM requires it); the absence of
comments or JSDoc.

## Open questions

Things that look like conventions but are not applied consistently live in
[architecture/open-questions.md](architecture/open-questions.md). Confirm there before treating one as
a rule.
<!-- construct:end -->
