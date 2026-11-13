# Post-deploy stability audit — deploy be8649e (PRs #153–#161, deployed 2026-11-12 ~20:05)

Date: 2026-11-12
Scope: read-only stability audit of the live app on http://127.0.0.1:4600 after deploy be8649e. No code changes, no POSTs to the app, no writes under ~/free-research-llm/data.

## 1. App up + research list grouping

Command: `curl -s 127.0.0.1:4600/api/status` → HTTP 200, `{"build":"cf4de78ff724","ready":true,...}` (all providers ready).

Command: `curl -s 127.0.0.1:4600/api/projects` → 50 researches; grouped exactly as `groupProjects` does in public/index.html (key = lowercased, whitespace-normalized question) → **12 groups**, matching the expected 12:

| runs | latest id | phase |
|---|---|---|
| 2 | find-appropriate-plots-to-buy-fo-b7772e | researching |
| 1 | find-the-wholesale-branded-secon-b2f5b7 | done |
| 1 | find-accurate-and-verified-car-l-0c750f | done |
| 2 | which-trendy-used-cars-priced-20-b4f648 | done |
| 1 | find-appropriate-plots-eligible--eb501e | done |
| 1 | create-an-action-plan-for-value--fc04bd | done |
| 1 | cars-to-sell-2000-4000-from-de-t-c97b3f | done |
| 22 | how-can-a-small-reseller-legally-d5ab7e | cancelled |
| 16 | which-used-car-models-and-age-mi-1b39c0 | cancelled |
| 1 | create-a-research-task-to-compil-6d6048 | tree-ready |
| 1 | which-czech-city-brno-ostrava-or-587d9f | done |
| 1 | is-it-profitable-to-buy-used-201-9a9292 | done |

## 2. Load-time GET endpoints for b7772e, b2f5b7, 0c750f

GET `api(` calls in public/index.html: boot calls `/api/whoami`, `/api/templates`, `/api/status`, `/api/projects`; opening a research adds `GET /api/projects/<id>` plus the SSE `GET /api/projects/<id>/events?client=…`; the project page also GETs `/api/principles?project=<id>`, `/api/projects/<id>/share`, and the header links `/api/projects/<id>/report.md`, `/handoff.md`, `/knowledge`, `/logs`. Full ids: `find-appropriate-plots-to-buy-fo-b7772e`, `find-the-wholesale-branded-secon-b2f5b7`, `find-accurate-and-verified-car-l-0c750f` (bare suffix ids 404, as expected).

All of the following answered **HTTP 200**:

- Base load GETs: `/api/status`, `/api/projects`, `/api/whoami`, `/api/templates` → 200 each.
- SSE: `curl --max-time 3 /api/projects/find-appropriate-plots-to-buy-fo-b7772e/events?client=audit` → HTTP 200, first frame `data: {"event":{"type":"hello","message":"connected","build":"cf4de78ff724"},...}`.
- Per research (all three ids): `/api/projects/<id>`, `/api/principles?project=<id>`, `/api/projects/<id>/share`, `/api/projects/<id>/report.md`, `/api/projects/<id>/handoff.md`, `/api/projects/<id>/knowledge`, `/api/projects/<id>/logs` → 7×3 = 21 calls, every one HTTP 200.

## 3. Share links owner-only (code + tests)

- src/share.mjs:7 — `const OWNER_ONLY_SUBPATHS = new Set(['/share', '/snapshots', '/restore']);` and src/share.mjs:22 — `if (OWNER_ONLY_SUBPATHS.has(rest)) return false;` inside `shareAllows`, so a share-token session is denied `GET /api/projects/<id>/snapshots` and `POST /api/projects/<id>/restore` (and `/share` itself).
- tests/share.test.ts:63-64 — test "keeps other researches, owner actions and the rest of the app closed" asserts `['GET','/api/projects/p1/snapshots']`, `['POST','/api/projects/p1/restore']`, `['GET','/api/projects/p1/share']`, `['POST','/api/projects/p1/share']` all evaluate to `false` via `shareAllows`.
- Note: `npx vitest run tests/share.test.ts` could not execute in this worktree (node_modules not installed here: ERR_MODULE_NOT_FOUND for 'vitest'); the assertion is cited from the test source at HEAD be8649e.

## 4. Saves refused since deploy (after 2026-11-12T19:05Z)

- `~/free-research-llm/data/logs/project-*.jsonl` (14 files): 15 log lines with ts ≥ 2026-11-12T19:05Z (all in project-…-b7772e.jsonl, candidate/phase lines 19:07:57Z–19:37:59Z) — **0** matches for "save refused", `RemovalRefusedError`, or "error". history.jsonl: 2 lines after cutoff, 0 hits; memory.jsonl: 3 lines after cutoff, 0 hits.
- App log `node /Users/m/free-research-llm/src/frl.mjs logs` (last 40 lines of data/logs/server.out): clean startup banner only, no errors. Full server.out (1892 lines): zero "save refused"/RemovalRefusedError anywhere; the only "error" lines are an old heap OOM (lines 602, 676) and old `ERR_MODULE_NOT_FOUND ws` start failures (lines 1139–1291), all before the last successful start banner at line 1885 — nothing after the current instance started.

**No save refusals since deploy.**

## 5. Journal / snapshots since deploy

- `~/free-research-llm/data/journal` contains exactly one file, `find-appropriate-plots-to-buy-fo-b7772e.jsonl`, with 2 lines, both after deploy:
  - `2026-11-12T19:34:31.384Z` reason "listings collected by code before the pieces" — nodes 30→30, rows 1000→1000 (78 removed)
  - `2026-11-12T19:34:31.544Z` reason "run started: start-of-run repairs applied" — nodes 30→30, rows 1000→1000
  → one research saved since deploy (b7772e), two journal lines; API agrees: snapshots endpoint for b7772e reports `journal.entries: 2, first 19:34:31.384Z, last 19:34:31.544Z`.
- `~/free-research-llm/data/projects/snapshots` does not exist — no snapshot files on disk; `GET /api/projects/<id>/snapshots` returns `{"snapshots":[]}` for b7772e, b2f5b7 and 0c750f (journal entries 2/0/0).

## 6. b7772e rerun state (started 19:07Z)

`GET /api/projects/find-appropriate-plots-to-buy-fo-b7772e`:

- phase: **researching** (updatedAt 2026-11-12T19:34:31.508Z, error: null)
- pieces: **30 nodes** (D1, D1.1, D4, D4.1, D6, D7, D7.1, D8, D1.1.1, D8.1, D8.2, D7.1.1, D1.2, D8.2.1, D13, D17, D1.1.1.1, D1.1.1.2, D13.3, D18, D8.2.1.1, D8.2.1.2, D8.1.1, D8.1.2, D8.2.1.1.b, D8.2.1.1.c, D7.1.1.c, D7.1.1.bx, D8.2.1.1.b.1, D8.2.1.1.b.3) — was 30, unchanged.
- kept rows: candidates.found 2977, **candidates.kept array length 1000** (keptCount 259, toCheck 100/174, screened out 1345) — was 1000, unchanged; matches journal rows 1000→1000.
- "covered by code": 26 log entries since 19:05Z, **zero** "covered by code" lines. The single such string in the whole project JSON is a log event from 2026-11-11T16:15:46Z (previous run) listing 68 old node ids — none of them exist in the current 30-piece tree, and no current piece is titled climate / district / data sources / sea access. The #156 matcher fix holds: no analysis piece is marked covered-by-code in the rerun.

## Defects

None found. App up (build cf4de78ff724), 12 groups as expected, all load-time GETs 200 for the three audited researches, share owner-only paths enforced in code and tests, zero save refusals after 2026-11-12T19:05Z, journal/snapshots consistent, b7772e rerun healthy at 30 pieces / 1000 kept rows with no covered-by-code tree lines.
