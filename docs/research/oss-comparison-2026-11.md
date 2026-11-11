# OSS research-engine comparison — 2026-11-11

Research report only (no source code changes). Compares this app's research engine (`src/research/*`, `src/llm/router.mjs`, CONCEPT.md, PROTOCOLS.md §4m) with seven successful open-source deep-research agents, and lists concrete adoptable improvements.

## 1. Sources actually fetched (URL + HTTP status)

All fetched with `curl -sL` on the raw GitHub `main` branch; every fetch returned HTTP 200.

| Project | URL actually fetched | HTTP status |
|---|---|---|
| assafelovic/gpt-researcher | https://raw.githubusercontent.com/assafelovic/gpt-researcher/main/README.md | 200 |
| stanford-oval/storm | https://raw.githubusercontent.com/stanford-oval/storm/main/README.md | 200 |
| langchain-ai/open_deep_research | https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/README.md | 200 |
| LearningCircuit/local-deep-research | https://raw.githubusercontent.com/LearningCircuit/local-deep-research/main/README.md | 200 |
| dzhng/deep-research | https://raw.githubusercontent.com/dzhng/deep-research/main/README.md | 200 |
| jina-ai/node-DeepResearch | https://raw.githubusercontent.com/jina-ai/node-DeepResearch/main/README.md | 200 |
| nickscamara/open-deep-research | https://raw.githubusercontent.com/nickscamara/open-deep-research/main/README.md | 200 |

## 2. What the fetched sources do

- **assafelovic/gpt-researcher**: planner + execution agents (planner generates research questions; execution/crawler agents gather info per question; publisher aggregates into the final report). Deep Research = recursive, tree-like exploration with configurable breadth/depth, running in parallel (~5 min, ~$0.4 with o3-mini). Before anything reaches the LLM it runs a context filter; by default **Jev** scores passage usefulness for the question (with a local keyword/BM25 fallback, no key needed).
- **stanford-oval/storm**: two-stage (pre-writing: research + outline; writing: full article from outline + references). Question quality is driven by perspective-guided question asking and a simulated conversation between a "Wikipedia writer" and a "topic expert"; Co-STORM adds a collaborative discourse (experts + moderator + human) and a dynamic mind map.
- **langchain-ai/open_deep_research**: LangGraph; purpose-specific models (Summarization / Research / Compression / Final Report); legacy plan-and-execute workflow and supervisor-researcher multi-agent implementation.
- **LearningCircuit/local-deep-research**: agentic research strategy — LLM decides what to search, which specialized engines (arXiv, PubMed, Semantic Scholar, …) to use, and when to synthesize; adaptively switches engines; quick vs detailed modes.
- **dzhng/deep-research**: simplest iterative deep-research loop: SERP queries → process results → produce learnings + directions; if depth > 0, next direction (prior goals, new questions, learnings) feeds back into research; else write markdown report.
- **jina-ai/node-DeepResearch**: search → read → reason loop that runs until the answer is found or the token budget is exceeded; action types (answer / reflect / search / visit) gated by checks (original question? definitive? has references? new URLs? new content?); a gaps queue drives follow-ups.
- **nickscamara/open-deep-research**: Firecrawl search + extract feeding a reasoning model; the reasoning model is kept separate for research analysis, data extraction and structured outputs.

## 3. Comparison table (project × technique × where × do we already do it? × gain for list researches)

| Project | Technique | Where in their pipeline | Do we already do it? (our file) | Gain for list researches (car listings / land plots / supplier lists) |
|---|---|---|---|---|
| assafelovic/gpt-researcher | Planner + execution agents; publisher aggregates; context filter (Jev/BM25); deep research tree (breadth/depth), parallel | Planner → questions → crawler per question → publisher. Context filter before LLM. Deep research: tree-like exploration. | Context filtering **yes** — `src/research/evidence.mjs` (BM25 passage ranking, RRF k=60, graded retrieval, one page per site first). Decomposition **yes** — `src/research/tree.mjs` (Q / D / D1.1). Deep research **partial** — `src/research/engine.mjs` + `src/research/result.mjs`. | Keeps listing summaries and candidate rows from flooding synthesis for 20-car / 50-plot / 10-supplier screens; parallel piece research when listing count grows. |
| stanford-oval/storm | Two-stage: research+outline (pre-writing) → article from outline+references (writing); perspective-guided Q asking; simulated conversation; Co-STORM discourse + mind map | Pre-writing stage; writing stage. Perspectives from sources; simulated expert conversation; mind map hierarchy. | Two-stage **partial** — we have tree → rollup → memo (`src/research/tree.mjs`, `src/research/engine.mjs`, `src/research/result.mjs`). Perspective-guided questioning **no** — we generate sub-questions from the user's question/decomposition, not from source-informed perspectives. | For land plots / supplier lists: source-informed perspectives would seed candidate criteria (sea, season, zoning, price trend) instead of generic sub-questions. |
| langchain-ai/open_deep_research | LangGraph with purpose-specific models (Summarization / Research / Compression / Final Report); plan-and-execute & supervisor-researcher multi-agent | Graph nodes per purpose. | Purpose-specific behaviour **yes** — `src/llm/router.mjs` (PURPOSE_CLASS, EXPECTED_OUTPUT_TOKENS for synthesize/decompose/research/improve/suggest/critique/support/rollup/decision-model). Research is single-agent tree, not multi-agent. | Summarization of N listing pages + compression before final report mirrors our per-piece report split; supplier-list structured extraction would use the "Data extraction" reasoning purpose. |
| LearningCircuit/local-deep-research | Agentic research strategy: LLM decides queries, engines, synthesis; adaptive engine switching; quick/detailed modes | Agent strategy layer. | Agentic strategy **partial** — `src/research/strategy.mjs` (decision models) and `src/research/engine.mjs` exist; runtime research strategy is checklist/portals-driven. | For car listings / land plots: agentic query choice across sources (marketplaces, not just "web") instead of fixed sweep seeds. |
| dzhng/deep-research | Iterative deep loop: learnings + directions; depth>0 → next direction → research; else report | Loop nodes: research → learnings/directions → (depth>0) next direction → research → report. | Iterative follow-ups **partial** — `src/research/followup.mjs` (MAX_FOLLOW_UPS=3), `src/research/improve.mjs` (loop). Depth control exists via tree depth. | For supplier lists: iterative deepening when first pass screens out too many listings. |
| jina-ai/node-DeepResearch | search → read → reason loop until answer or token budget exceeded; action types gated by checks; gaps queue | Init → CheckBudget → GetQuestion → GenPrompt → ModelGen → ActionCheck → {answer/reflect/search/visit} → Evaluate. | Answer/gap handling **partial** — `src/research/gaps.mjs` (FIX_CHECKS/RESEARCH_CHECKS/NEEDS_USER), `src/research/memocheck.mjs`, `src/research/improve.mjs`. | For car listings: answer must be judged "definitive" + "has references" before it counts toward the expected result. |
| nickscamara/open-deep-research | Firecrawl search+extract; separate reasoning model for research analysis / data extraction / structured outputs; BYPASS_JSON_VALIDATION | Reasoning model usage; extraction prompts. | Reasoning-vs-research split **partial** — `src/llm/router.mjs` purpose tiers, but no separate reasoning model for extraction/structured checks. | For supplier lists: structured extraction of supplier fields (name, country, price, reliability) into the candidate table. |

## 4. Ranked improvements (max 6)

### 1 — Adopt a learned/usefulness context filter (Jev-style) before synthesis

- **What**: keep the existing BM25 passage ranking in `src/research/evidence.mjs`, add a learned/usefulness scoring stage (Jev-style: score passage usefulness for the question, not just lexical similarity) before the synthesis call, with BM25 retained as the no-key fallback.
- **Why** (fetched source, assafelovic/gpt-researcher README.md, HTTP 200): *"By default it uses Jev by TypeSafe, a model that scores how useful each passage is for the question, rather than how similar its words or embedding are."*
- **Files that would change**: `src/research/evidence.mjs` (+ possibly a new module under `src/research/`).
- **How to test**: add `tests/research/evidence.test.mjs` cases for usefulness-scored ranking vs BM25 fallback; run `npx vitest run tests/research/evidence.test.mjs`.
- **Effort**: S / M.

### 2 — Add a token-budget-bounded deep-research loop

- **What**: enforce the research loop's token budget (stop condition) like the *"until the token budget is exceeded"* behaviour, with a final/answer step.
- **Why** (fetched source, jina-ai/node-DeepResearch README.md, HTTP 200): *"Keep searching, reading webpages, reasoning until an answer is found (or the token budget is exceeded)."*
- **Files that would change**: `src/research/engine.mjs`, `src/research/improve.mjs`, `src/llm/router.mjs` (budget wiring).
- **How to test**: `npx vitest run tests/research/engine.test.mjs` for budget-exceeded stop and BeastMode-equivalent final answer.
- **Effort**: M.

### 3 — Add source-informed perspective question generation

- **What**: generate sub-questions from perspectives surfaced by the fetched sources, not only from the user's decomposition.
- **Why** (fetched source, stanford-oval/storm README.md, HTTP 200): *"STORM identifies the core of automating the research process as automatically coming up with good questions to ask. Directly prompting the language model to ask questions does not work well."*
- **Files that would change**: `src/research/prompts.mjs`, `src/research/tree.mjs`.
- **How to test**: `npx vitest run tests/research/prompts.test.mjs` for perspective-seeded sub-question generation.
- **Effort**: M.

### 4 — Add iterative deepening loop (learnings → next direction → research → report)

- **What**: when depth is allowed, feed learnings + new questions back as a next research direction before finalising.
- **Why** (fetched source, dzhng/deep-research README.md, HTTP 200): *"The goal of this repo is to provide the simplest implementation of a deep research agent - e.g. an agent that can refine its research direction over time and deep dive into a topic."*
- **Files that would change**: `src/research/tree.mjs`, `src/research/followup.mjs`, `src/research/improve.mjs`.
- **How to test**: `npx vitest run tests/research/followup.test.mjs` and `tests/research/improve.test.mjs`.
- **Effort**: L.

### 5 — Move research strategy toward an agentic mode (LLM decides queries/engines)

- **What**: let the research strategy layer choose queries and engines agentically (with fallbacks), instead of only fixed checklist/portals-driven sweeps.
- **Why** (fetched source, LearningCircuit/local-deep-research README.md, HTTP 200): *"An autonomous agentic research mode where the LLM decides what to search, which specialized engines to use (arXiv, PubMed, Semantic Scholar, etc.), and when to synthesize. It adaptively switches between search engines based on what it finds and collects significantly more sources than pipeline-based strategies"*.
- **Files that would change**: `src/research/strategy.mjs`, `src/research/engine.mjs`, `src/research/sweep.mjs`.
- **How to test**: `npx vitest run tests/research/strategy.test.mjs`.
- **Effort**: L.

### 6 — Add multi-agent fan-out for independent pieces (supervisor/researcher) with parallel execution

- **What**: fan out independent sub-questions to specialised research passes with a supervisor, instead of serial piece handling.
- **Why** (fetched source, assafelovic/gpt-researcher README.md, HTTP 200): *"Research runs in parallel, which keeps it fast, stable and reliable, and reduces misinformation."*
- **Files that would change**: `src/research/engine.mjs`, `src/research/lanes.mjs`, `src/research/monitor.mjs`.
- **How to test**: `npx vitest run tests/research/engine.test.mjs` for fan-out scheduling and merge.
- **Effort**: M / L.

## 5. Unadopted / partially adopted ideas worth a look

- **Reasoning-model split** (nickscamara/open-deep-research, fetched HTTP 200): reasoning model separate for research analysis / data extraction / structured outputs — we approximate with purpose tiers in `src/llm/router.mjs`, but lack a dedicated reasoning pass for structured checks.
- **Egress control, knowledge-base compounding, quick-summary mode** (LearningCircuit/local-deep-research, fetched HTTP 200) — relevant to list researches running many listings.
- **Web scraping via headless browser / JS rendering** — we already do this in `src/search/browser.mjs` (per CONCEPT.md).

## 6. Commit

Only `docs/research/oss-comparison-2026-11.md` is committed by this task.
