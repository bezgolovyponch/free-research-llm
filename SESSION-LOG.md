# Session log

How this app was built, what each session decided, and what is still open. Run-time history of your own researches is in the app (**History** tab) and in `data/logs/`.

## Session 2026-11-02 · team round 2: c1–c4 merged + verifier fix #68; next round launched

Asked: complete the c1–c4 worker round, record the merged PRs, and start the next round of workers on the remaining open items.

- **PRs #62–#67 (c1–c4 round, all merged to main 56e4b05):**
  - **#62:** CZ glamping legal path. 4 sources; all 5 quotes confirmed by the app's own StrategyRetriever at 21:04Z. Czech zoning words added to the brief.
  - **#63:** thrown quota errors are recorded as provider-outage, and outages are left out of stallCheck. Before: eb501e had 55 such 'error' trials and b7772e had 42. The loop-hours message is rounded.
  - **#64:** checks follow the question's clauses via `askedCriteria`; the Czech research no longer gets sea, season, no-AC or trend checks. A Czech row with no coast data under a foundation from the Czech question has no 'sea'/'season'/'noAc'/'trend' check and its verdict does not mention the sea; the original question still gets all checks.
  - **#65:** Czech seeds sreality and bezrealitky, read live with 22 and 30 priced plots. idnes was dropped because its search returned only news. sreality priceCzk is read, and code-like titles fall back to the URL.
  - **#66:** `budgetOf` takes the price limit from the question when the acceptance has none; Czech, Slovak and Polish land words added.
  - **#67:** `currencyOf('€ EUR')` fixed, which had let 645,100 EUR pass as CZK; Czech and Polish rentals and wanted ads refused. Found by the dry run of merged main on a copy of eb501e: 26 fits, of which 5 were wrong.
  - **Live after deploy (22:44Z):** eb501e went from 0 fits to 75 fits out of 404 found; 159 screened for price outside 0–1,000,000 CZK, 6 rentals, 3 wanted ads. b7772e (coastal) still runs every check: 328 fits, 178 trade-offs.

- **PR #68 (verifier fix, merged 56e4b05, deployed):**
  - **Before:** external verifier on eb501e gave 0 confirmed, 104 refuted, 5 unconfirmed. Every refutation was the sea check (which the Czech question never asks for). The verifier also read the price limit as 0–null because it ignored a budget stated in the question, and compared a limit against EUR prices without converting the limit's currency.
  - **After:** 59 confirmed, 2 refuted, 48 unconfirmed. The refuted ones are a listing that geocodes to Norway and a page whose price doesn't match. 42 of the unconfirmed are prices the verifier's own page reader doesn't find, mostly on client-rendered sreality pages.
  - **Fix stays independent of app code:** the sea check runs only when the user's words ask for the sea; `statedLimit()` reads the budget from the question when the acceptance has no range; the limit is converted to EUR before comparing.
  - **Next for verifier:** read sreality's embedded "priceCzk" with its own code, which would turn most of the 42 into real verdicts.

- **Worker lesson (from c1–c4):** give workers real URL shapes. One worker invented fixture URLs that fail `looksLikeListing`, and another changed `parseAmounts` (shared) and left debug logs in.

- **Open items for next round (launched 4 workers):**
  1. **Principles in App chat / Results tab** (w1): cross-research principles recorded in `lessons.mjs` and shown to the loop proposer, but never surfaced to the user. New API `GET /api/principles` + App chat handler + Results tab section.
  2. **German land on CZ-language portal mirror** (w2): e.g. `reality.bazos.cz/inzerat/.../obercarsdorf-dippoldiswalde-sasko` (Saxony, Germany) pinned to CZ because of .cz TLD. Fix: detect foreign state names in slug/title and override the mirror TLD.
  3. **CZ detail-page lat/lon** (w3): 44 Czech listings have no location; bezrealitky and sreality detail pages embed coordinates in `__NEXT_DATA__` / JSON-LD; sweep must fetch detail pages for empty-location rows and cache coords.
  4. **CZ units rule from Czech law** (w4): current strategy hardcodes Portuguese Portaria 1320/2008 rules for CZ. Need Czech-specific pitchM2, campingShare, ruralMaxM2, ruralMaxUnits with a real citable Czech source (agent researching cz-law.md).

- **Gate:** all 4 PRs passed CI on Node 22 and 24 before merge; main is in sync with origin/main (56e4b05). App restarted 00:30Z; both loops resumed on eb501e and b7772e.

## Session 2026-11-01 (2) · the price trend is retried until the source answers

Asked: why the Eurostat price trend is part of "fits", why it failed, and that the app must keep retrieving until it gets the data, using the mechanics real products use.

- **Why it is part of "fits":** the low-entry glamping decision model maps the clause "strong price increase trend" (`src/research/strategy.mjs`, criterion `trend`) to the Eurostat house price index of the country against the EU average. `planFor` applies all of the model's checks to every plot, including this one, whether or not the question names it. A plot is "fits" only when every check is measured and met, so a missing country series moved every plot of that country to "to confirm".
- **Why it failed (from the code; the Mac's logs are not in this sandbox):** (1) `httpJson` retried HTTP 429/5xx but not a dropped connection or a timeout, so a transient network error failed at once; (2) the background measuring worker started only when places were unmeasured, so a missing series was never fetched again; (3) loop trials run in cache mode and cannot fetch; (4) before PR #44, a failed read was cached as "no series" for 30 days. Eurostat itself could not be reached from this cloud sandbox (its network policy denies `ec.europa.eu`), so the live API was not tested here.
- **Mechanics adopted (AWS SDK standard retry strategy, "exponential backoff with full jitter"):** `backoffMs` waits a random share of a doubling window (base 1 min, cap 6 h); the app records each failure (`failures`, `retryAt`) and retries without a limit on the number of attempts, so it keeps trying until the source answers without hammering it. `transientError` classifies dropped connections and timeouts as retryable; HTTP refusals stay final. `httpJson` now retries network errors with the existing waits.
- **Keeps retrieving:** `trendGaps` reports missing series and those due for a retry; the engine starts the background worker when a series is due (not only when places are pending), and logs "price trend still missing for …". `trends()` re-reads the shared cache first, so a series fetched by the worker reaches the table.
- **Tests:** `tests/research/site.test.ts` (backoff range and cap, transient vs final errors, outage → wait → retry → kept, 25 failures in a row stay capped, `httpJson` retries a network error but not a 404 or `noRetry`); `tests/research/engine.test.ts` (the "still missing" log). Gate: 706 unit tests pass; e2e fails only for the sandbox reason.
- **Race fixed in review:** the shared cache merges by timestamp, so a failure recorded after another worker fetched the series could replace the good value. `merge` now keeps an entry with a value over one without, for the price series only. Test: "shared cache merge keeps a fetched price series over a newer failure".
- **Audit (separate session, on c7a7233):** one blocker and three should-fix, all reproduced by the auditor with the branch's own code and fixed here, each with a test that fails on the previous code:
  1. Blocker: `trends()` merged the whole shared file on every apply, including loop trials in cache mode, so a trial could be credited with a worker's new measurements. Now cache mode reads nothing from disk, and other modes merge only the price series.
  2. A failure with no earlier value was stored with `at: now` and could win a merge; it now stores `at: 0`.
  3. Repeated failures kept the same `at`, so other processes never saw the growing backoff; the price series now merges by `checked`, the time of the last attempt.
  4. The log said "waiting for the next retry" as if a timer ran; no timer exists, so it now says the next try happens when the wait ends and the table is rebuilt.
  - Notes also fixed: an HTTP 4xx refusal is a miss kept for 24 h, not an outage retried forever; `httpJson` no longer retries timeouts (a call could take about 8 min); Eurostat calls time out at 30 s.
- **Open:** a second source for countries Eurostat does not publish, or when it is down for days (OECD, BIS residential property prices). Not added: their endpoints could not be verified from this sandbox, and an endpoint that was not tested would not be shipped. Allowing `ec.europa.eu`, `sdmx.oecd.org` and `stats.bis.org` in the environment's network settings would let it be verified and added.

## Session 2026-11-01 · why results were "to confirm" and no plot was "fits"

Asked: why every result is to confirm and none fits, why the expected result reads 100% met, and why the improve loop cannot confirm anything itself.

- **Why no "fits":** a plot is "fits" only when every decision-model check is measured and met (`src/research/strategy.mjs`, `planFor`). A check that cannot be measured is `null`, which makes the plot "to confirm". Six checks: sea distance (null without a location, or within the map's ±2 km when the rough coastline is used), camping season and no-air-conditioning (null while the climate is unmeasured or the map service is busy), units (null without an area), the country price trend (null without an official series), location consistency (null on a place conflict), and the legal path (null for a country with no researched path).
- **Defect found:** `SiteAssessor.priceTrend` (`src/research/site.mjs`) cached a failed Eurostat read as a valid "no series" answer, with the 30-day TTL. One outage therefore marked every plot of that country "to confirm" for a month. The price trend is country-level, so the whole country was affected at once.
- **Fix:** a failed read is not stored; a genuine "no series" is kept for 24 h (`MISS_TTL_MS`), a value for 30 days. Test: `tests/research/site.test.ts` ("a failed Eurostat read is not an answer"). The test fails on the previous code and passes on the fix.
- **Why the improve loop cannot confirm these:** a loop trial runs in cache mode (`MODES.cache`: no new sites, no page reads, no map queries). It cannot fetch a missing price series or measure a new place, so the same checks stay null across trials. The external verifier (`verifier/verify.mjs`) re-measures price, area, coordinates, sea distance and the months, but not the country trend or the legal path, so a verified plot still stays "to confirm" on those two checks.
- **Not verified here:** the "100% met" figure. It comes from `acceptance.mjs` (`evaluate`), which averages per-check values, and the value is capped at 1. If only the confirmed items are counted, every measured check can be 1, which gives 100% while most plots are unmeasured. The project data is not in this sandbox, so this is a hypothesis to check on a live research.
- **Open decisions:** whether verifier-confirmed measurements should move a plot to "fits" while the country-level checks are shown separately, and where the country trend should come from when Eurostat is unreachable.

## Session 2026-10-31 (6) · the loop tries the whole question last

Asked: a full-cycle pass on the review suggestions: fix, test, merge, audit, fix again.

- **Problem (review suggestion 3):** the whole question (Q) was first in every loop pass. A Q trial re-rolls the whole research, so it was the most-tried target (12 trials, 3 kept in the 2026-10-23 review) and consumed trials that piece-level changes would have used better.
- **Change:** `improvementTargets` now lists pieces first, by weakness and priority, and Q last. Q keeps its single slot per pass (`tried` set), so a pass still reaches it when pieces are exhausted or resting.
- **Tests:** `tests/research/improve.test.ts` updated to the new order. `tests/research/improve/scoreDelta.test.ts` (removal record) now stubs piece trials so the removal trial is the only one that runs. It had depended on Q running first: with Q last, piece trials raise the baseline and the removal is correctly reverted, so the test was not measuring the removal in the old form.
- **Gate:** 694 unit tests pass; e2e fails in this sandbox for the environment reason (WebKit missing, Chromium build mismatch). The Chromium project passes 13 of 13 when run with the installed browser via a temporary config.
- **Audit (separate read-only session, PR #43):** no concept blocker. Should-fix: with Q last, a deadline inside a pass could end the loop before Q got any trial. Fixed: `nextTarget` makes Q due after `ROOT_EVERY` (3) piece trials in a pass, once per pass, and falls back to Q when every piece is tried, resting or claimed. Tests: `tests/research/improve/nextTarget.test.ts` (6 cases). The audit could not run vitest (plan mode); this run did: 43 improve tests pass.
- **Audit note, accepted:** a Q trial can run after pieces were kept in the same pass, so a Q removal is judged against the raised baseline. A removal that drops an improved piece is reverted, not lost.
- **Open:** whether Q should run every pass at all is a product choice; this change only orders it and bounds how long it can wait.

## Session 2026-10-31 (5) · PR #42 review: synthetic row removed from the cadastral path

- **Defect found in review:** `src/research/engine.mjs` inserted a row with an empty URL, built from a parcel node's finding, into the counted candidate table and raised `found` and `keptCount`. A counted row must come from a listing page the app read (CONCEPT.md step 6). Removed the block; the parcel finding stays in the piece report and memo, not the table.
- **Tests:** `tests/research/cadastral.test.ts` adds two cases: the cadastral strategy leaves kept rows and counts unchanged when no listing was read, and every counted row keeps a non-empty URL. Note: these guard the strategy function; the engine block itself was deleted, so they do not reproduce the original injection on their own.