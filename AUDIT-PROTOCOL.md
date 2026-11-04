# AUDIT PROTOCOL — mandatory for every task on this app

App changes start in the App chat as tickets (`data/changes/C<n>.md`, see [CONCEPT.md](CONCEPT.md#changing-the-app-from-the-app-chat)); the ticket's request and desired output are the S2 checklist. Anyone who changes this app or reports on it (a person, Claude Code, any agent) runs this protocol twice: **when a task starts** and **before the result is reported**. Nothing is reported as done until every check has a recorded answer.

It adapts three existing protocols instead of inventing a new one (and the mikoshi rule that the proof is chosen per change: a unit test for a pure function, a witness on real data for anything that acts on real data):

- **mikoshi-construct 0.43.0** (the construct used across this workspace): a pass is reported by the gate, never by the author; security is checked as its own dimension; every changed logic module ships with its test.
- **Chain-of-Verification** (Dhuliawala et al., 2023, arXiv:2309.11495): draft, list the verification questions, answer them independently, then revise. The app's own reply audit is built on it ([CONCEPT.md](CONCEPT.md#the-reply-audit-every-chat-every-reply)).
- **This app's protocols** ([PROTOCOLS.md](PROTOCOLS.md)): gates decide results; a model never grades itself.

## Part 1 · At the start of every task

| # | Check | How to answer it |
|---|---|---|
| S1 | **Concept fit.** Which flow, chat scope or document of [CONCEPT.md](CONCEPT.md) does the task touch? Does it keep "a model proposes, code decides"? | Name the flow. If the task would let a model create, delete, grade or run something without a button or a gate, stop and redesign |
| S2 | **Restate the ask.** List every numbered or separate request in the user's message, word for word, including ones sent mid-task | A checklist. Each item ends as done, blocked (with the reason) or asked |
| S3 | **Current state.** Read the code and the data the task touches before planning: the files, the live app (`node src/frl.mjs status`), the last handoff, the open items in [SESSION-LOG.md](SESSION-LOG.md) | File paths and the observed behaviour, not memory |
| S4 | **Facts that need a source.** Any price, limit, free tier, command, package name or API behaviour the result will state | Look each up in official docs (or test it live) now, and note the source and date |
| S5 | **Risk.** Does the task touch keys, the access token, remote access, the terminal, deletion, or anything that spends money? | If yes: write down the safe default and what needs the user's explicit consent |
| S6 | **Adjacent gaps.** What in the same flow would still be broken after the obvious fix? | Fix gaps in the same flow in the same pass; list the rest |
| S7 | **Witness on live data.** Does the change act on existing researches (repairs, re-grading, gates, scoring, item screening, routing on measured data)? | Before deploying, run it on a copy of the live research (`node scripts/dryrun.mjs <research id>`, or the equivalent read-only check) and read every change it reports. A wrong change found there is fixed before anything ships (2026-10-23: the candidates repair renamed "Market demand"; the speed check read a cached prompt as 0 tokens/s) |
| S9 | **Concept audit.** Run `node scripts/concept-audit.mjs --all` and walk [Part 4](#part-4--known-failure-modes-mandatory) for the layers the task touches | Every ✗ is fixed or named as a blocker before planning; every ⚠ is listed |
| S8 | **Measurements.** Any before/after comparison | Times in one zone (UTC, with `Z`); windows and counts stated; too few samples are labelled as such |

## Part 2 · Before reporting the result

| # | Check | Pass when |
|---|---|---|
| O1 | **Every request covered.** Walk the S2 checklist | Every item is done, or its blocker is stated in plain words |
| O2 | **Gate.** `npm run quality`, run by a read-only verifier (in Claude Code, mikoshi's `harness` agent), not by the author | It prints `quality gate: PASSED`. Quote its summary lines; never write "tests pass" without them |
| O2c | **Results signed off outside the app.** Any change to how results are produced | The external verifier (`node verifier/verify.mjs <id> --data <scratch dir> --projects data/projects`) is run on a live research and its confirmed, refuted and unconfirmed counts are reported; the app's own gates never certify a result |
| O2b | **CI before merge.** | The change is on a branch with a pull request, CI passes on Node 22 and 24, then it is merged; `main` is never pushed directly (the pre-push hook refuses it). New or changed tests pass 3 times in a row (`flakes` gate) |
| O3 | **Tests for changed logic.** Every new or changed module in `src/` | It has `tests/<same path>.test.ts` that fails without the change |
| O4 | **Real use.** The change works in the running app, not only in tests | Exercised through the HTTP API, the browser (e2e) or the terminal. Say which, and what was seen |
| O5 | **Every link in the report.** | Opened, or copied from a page that was fetched. No invented URLs, no `example.com` |
| O6 | **Every command in the report.** | Exists in this repo (`node src/frl.mjs …`, `npm run …`) or in the tool's official docs, and was run or syntax-checked where possible |
| O7 | **Every number and claim.** | Has its source (doc + date, or the command output). Unverified items are labelled as such |
| O8 | **No secrets.** | No key, token or passphrase in code, docs, logs, chat threads or the report. Placeholders such as `${VAR}` only |
| O9 | **No false claims of action.** | Every "created / deleted / pushed / installed" in the report matches a command whose output was seen |
| O10 | **Concept still holds.** Re-check S1 against the final change | Chats stay in their scope; nothing runs without a gate or a button |
| O12 | **Every suggestion is ready to execute.** Anything the app or the report tells the user to do | It names the exact URL, the exact button or field, and the exact command, taken from a provider's docs or this repo (key steps live in `src/llm/guides.mjs`). "Go to the website" alone fails |
| O13 | **Concept audit again.** `node scripts/concept-audit.mjs --all` after deploy, and Part 4 re-walked for the touched layers | No new ✗; any ⚠ is reported with its count |
| O11 | **Record.** | [SESSION-LOG.md](SESSION-LOG.md) has the session: what was asked, what changed, what is still open |

A failed check is fixed, then the whole of Part 2 runs again. If a check cannot pass (for example, a permission was refused), the report says so in the first lines.

## Part 3 · What the app enforces on its own replies

The same rules run in code on every chat reply, before you see it ([`src/chat/reply-audit.mjs`](src/chat/reply-audit.mjs)): unknown links removed, secret values removed, unknown commands flagged, placeholders flagged, claimed-but-not-run actions flagged, one revision on failure, then a visible **⚠ audit** mark. Tests: [`tests/chat/reply-audit.test.ts`](tests/chat/reply-audit.test.ts), [`tests/appchat.test.ts`](tests/appchat.test.ts).

## Part 4 · Known failure modes (mandatory)

Every row happened in this app (date, PR) or is the same failure in another place. Each audit walks the rows of the layers it touches; **C-ids** are checked by code on live data (`src/research/conceptaudit.mjs`, run by `node scripts/concept-audit.mjs --all`, shown in each research's **Notifications** tab).

### A · Concept: what counts as a result
| # | Failure | How it is caught |
|---|---|---|
| A1 | The headline count included rows that do not fit every check (2026-11-02: 338 shown, 307 fit and were confirmed) | C1; `applyVerification` counts fits ∧ confirmed |
| A2 | A plot counted with a check unmeasured or failed | C2 |
| A3 | A plot counted where the buyer cannot own land (Vietnam), or a lease shown as a purchase (#77, rejected) | C3; PROTOCOLS 2c: lease options are a separate alert, never a fit |
| A4 | Rows from countries not asked for; "EU" overriding the named countries | C4; brief tests |
| A5 | Price limit broken by a wrong currency (645,100 EUR read as CZK, #67) or a deposit read as the price | C5; low-outlier rule; verifier price check |
| A6 | Checks the user never asked for (sea check on an inland Czech question, #64, #68) | `askedCriteria` tests; verifier `obligationsOf` tests |
| A7 | An asked country never reaches the table (Vietnam: no readable land portal) | C13 and the lease alert says so |
| A8 | Fits hidden by a stale cached record (cached site without climate index, 2026-10-27) | witness on a copy before deploy (S7) |
| A9 | A list research outside the plot flow delivered nothing and the audit said nothing (cars, 2026-11-03: 0 of 10 links) | C15, C17 |
| A10 | A research kept a removed template (car-arbitrage, removed 2026-10-20) | C16 |
| A11 | A list research did its identify and screen stages as tree pieces over web search (car research 0c750f, 2026-11-03: 62 pages, none on a marketplace, 0 listings) | PROTOCOLS 4m: listings first by code, tree only for what listings cannot show |
| A12 | "Within 300 km of Prague" gave no countries, so no portal was read | `radiusIn`, `areaCountries` |
| A13 | Plot measurements (sea, climate, cadastre) ran on a car list and hung the run for 20+ min | `needsSiteFit`: only when a strategy or a site criterion asks |
| A14 | Parts, wheels and lights counted as cars; the kind's exclusion words were English only (0c750f, 2026-11-03: 538 kept) | `calibrateKind` (3-sample majority on real titles), `implausiblyLow` |
| A15 | The memo said 15 results while the table held 70 and the acceptance check passed | `shortlistText` final counts, verdict starts with `tableVerdict` |
| A16 | Table columns labelled € for CZK values | columns carry no currency; each value shows its unit |
| A17 | Communities and expert sources never searched; knowledge pieces asked in generic English (12 of 14 weak) | `planKnowledgeQueries` |
| A18 | "Underpriced" claimed on thin facts: ad dates read as model years, comparables of other years unadjusted, parts priced like cars (witness 2026-11-03: a 2006 car 'worth' 55,000 CZK) | `listingFacts` date rules; Theil–Sen adjustment; no value without year or mileage; highlight only at medium or high confidence |
| A19 | Identification pieces were dropped for an item no portal lists, and supplier pages abroad were dropped for not naming the shop's country (wholesale suppliers b2f5b7, 2026-11-03: 3 weak pieces left, nothing to find the suppliers) | `listedKind`, `brief.located`; PROTOCOLS 4m |
| A20 | "20 direct links" gave no item count, so the decision model was built after the tree | `itemCountFromWords` allows two describing words |
| A23 | A research on a kind no portal lists (wholesale suppliers b2f5b7, 2026-11-04) kept 0 of 126 rows: a candidate table of junk page rows was built and replaced the pieces' findings as the result, providers were rejected as "not a single listing page" (a rule the user never asked for), the region screen still applied, and model-written kind terms used U+2011 hyphens that never match | `brief.located === false`: no candidate table, results from the pieces, a page that opens and states the asked kind (`kindOnPage`); `plain` maps Unicode dashes; C20 |
| A21 | Car values were artefacts (verified 2026-11-04 on 0c750f): each listing was in its own comparables and every comparable counted twice (market rows had no URL); 90% of listings had no year because only titles were read; slopes came from 2–9 points (Ibiza +73%/year); a Fabia I was valued from a 2013 Fabia II; a +10/−15% assumption changed values; values were one listing's asking price shown as "worth". Rebuilt from titles only, 0 of 235 could be valued | `readListingFacts`, `adText`; `marketSample` dedupe by `listingKey`; `pooledSlopes` (≥ 30 dated); ±2-year comparables, ≥ 5; P25–P75 range; flag below P25 only; calibration check: 25 / 45 / 30 of 100 below / inside / above |
| A22 | A "bargain" flag from the comparables' own spread (P25), with no coverage guarantee; the published method (jackknife on the method's own errors) gives an 80% interval of 0.47–1.51 × the estimate on 0c750f and flags none (2026-11-04) | `calibrate`; PROTOCOLS 7c-sources |

### B · Evidence and gates
| # | Failure | How it is caught |
|---|---|---|
| B1 | A quote that exists but says something else ("Bell tents cost from €950" for a permit) | meaning check (PROTOCOLS 2b); C9, C10 |
| B2 | A fabricated or non-verbatim quote in a peer PR (#72, #77) | re-read every quote live before merge; StrategyRetriever weekly; C11 |
| B3 | Source ids or years read as numbers (S4, "1911 km", #85) | support and verifier tests |
| B4 | The memo states numbers the verified record contradicts | C12; memo claim check |
| B5 | A model grades itself | reviewer and meaning votes avoid the author's provider |

### C · Outside verifier
| # | Failure | How it is caught |
|---|---|---|
| C-1 | Verifier stalled at 0 fits, so nothing was ever confirmed (2026-10-31) | C6 |
| C-2 | Verifier read an old project file and wrote an empty record marked complete (2026-10-27) | C6; inputs hash in the record |
| C-3 | Verifier and app disagree on many fits (pisos card prices, #81) | C7: refuted share > 30% means the table logic is suspect |
| C-4 | Verifier imports app code | `independence` gate |

### D · Loop and routing
| # | Failure | How it is caught |
|---|---|---|
| D1 | Provider outages counted as stalls, or starving the loop (#63; 2026-11-02 most trials provider-outage) | C8; outcome 'provider-outage' |
| D2 | Re-measure that re-ran nothing, so noise was 0 (#74) | improve tests |
| D3 | Free provider limits misread (OpenRouter 50 requests/day; Gemini 20/day; Cerebras 402) | measure before routing; Models & router page |
| D4 | A slow local model gets calls (llamacpp: 20 of 200 calls worked, median 116 s) | router switch; speed check |
| D5 | Two app servers on one data folder (2026-10-31) | instance lock |
| D6 | Memory exhaustion from dead live-update connections (2026-10-23) | heap guard, watchdog |
| D7 | Stop ignored after the pieces: a stopped research kept sweeping and writing its memo (2026-11-03) | `stopIfCancelled` after every stage |
| D8 | A restart would resume a research the user had stopped | shutdown saves no resume for a stopped run and marks it cancelled |
| D9 | A provider stayed "dead" for hours after it recovered: fcc's last 20 calls timed out (14:14–18:01Z), so it ranked last and never got the call that would clear it (2026-11-03) | `DEAD_WINDOW_MS`: failures older than 30 min no longer demote |
| D10 | A provider that never answered was ranked first and reserved for the top calls on its prior alone (Puter, 2026-11-03: "subscription required") | `neverAnswered` in `ranking.mjs` |
| D11 | A proxy provider timed out at the tier timeout (45/90 s) while it queued behind remote models | preset `callTimeoutMs` (fcc 240 s) |
| D12 | Calls queued minutes behind a paced provider (Pollinations, one reply per 45 s per IP) while others were free, and the queue wait was recorded as reply time (median 38–57 s, 2026-11-03) | `queueMs`, `QUEUE_DEMOTE_MS`; ledger `ms` excludes `waitMs` |
| D13 | A provider without a free tier (Cerebras 402 "Payment required" since 2026-07-21, Puter "subscription required") rested only until midnight and failed first again every day | `PAYMENT_REST_MS` 24 h, restored after a restart; speed ranks by time per useful answer (`msPerAnswer`) |

### E · Change process
| # | Failure | How it is caught |
|---|---|---|
| E1 | Merged before CI had even started (#88, 2026-11-02) | wait until both Node 22 and 24 checks exist and are SUCCESS; never merge on "no checks reported" |
| E2 | A PR deleting history or files beyond its purpose (#69: 644 lines) | review the full file list and every deleted line; count lost lines for docs |
| E3 | `node_modules` symlink committed and deployed (#52) | stage explicit paths only; ignore rule `node_modules` |
| E4 | Workers inventing fixture URLs or editing shared parsers (c1–c4) | real URL shapes in the spec; review every changed file |
| E5 | Bot checks or consent redirects worked around | never: a site that refuses automated reads is left alone |
| E6 | A claim of action that did not happen | O9; quote the command output |
| E7 | Keys in a file | keys only in the key store or the process environment |
| E8 | The lead ran its own copy of a research instead of the user's (2026-11-03: created b4f648 while the user's 0c750f waited; about an hour lost) | before acting on "the research", list researches by creation time, take the newest the user created, confirm its id and question in the reply; never create a research the user did not ask for |
| E9 | Bugs found one per full live re-run (7–15 min each) | replay first: `node scripts/dryrun.mjs <id> --sweep` reads the portals by code with no model calls; batch one round's fixes into one PR |
| E10 | A long command waited on a condition that could not happen (cancel during the old candidate stage) | wait loops end on every terminal state and carry a timeout; check the stage the run is in before waiting |
| E11 | Pages were read and scrapers planned before the purpose was stated (car research, 2026-11-03) | stage 0 of PROTOCOLS 4m: why, value, needs, a source per need, generic reader first; a custom scraper only for a proven-necessary source the generic reader fails on |
| E12 | A concept change fixed in one stage only: #110 made the search side aware of kinds no portal lists, the result side (table, item screen, acceptance) kept listing rules and the user's research stalled at 0 results | when a concept or flag changes, trace it through every stage of the flow (brief → search → screen → table → acceptance → audit) and add a concept-audit check for the combination (C20) in the same change |
