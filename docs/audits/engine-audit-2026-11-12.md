# Engine audit 2026-11-12

Five read-only auditors (Claude Fable 5.2) examined origin/main plus PRs #155–#162. Each auditor took one layer and used real data as evidence: researches b7772e (plots), 0c750f (cars) and b2f5b7 (wholesale suppliers), their logs, and 1,351 router calls. 70 findings. Every finding's code quotes, evidence, fix and test are in the appendix of its area ([engine-audit-2026-11-12/](engine-audit-2026-11-12/)).

Definite bugs were fixed in this PR when a failing test on the real input reproduced them first. Anything that did not reproduce is marked refuted. Design decisions are marked deferred. Everything else is the spec for the next full audit fix PR.

| Status | Findings |
|---|---|
| fixed here | 38 |
| refuted | 0 |
| already fixed | 0 |
| deferred | 1 |
| next PR | 31 |

## Concept and question intake (CONCEPT)

| Id | Finding | Class | Severity | Status |
|---|---|---|---|---|
| CONCEPT-1 | Rebuilding the decision model wipes the calibrated sub-type and the validated kind, so the next table loses its main screen | definite bug | high | fixed here |
| CONCEPT-2 | The brief drops the kind's exclusion, condition and upgrade words, so calibration never screens anything | definite bug | high | fixed here |
| CONCEPT-3 | A criterion without a stated limit borrows the limit of another research's question, from cases nobody approved | definite bug | high | fixed here |
| CONCEPT-4 | The concept audit checks nothing on a list without tiers: C2, C3 and C5 pass on zero rows | definite bug | medium | fixed here (C5 reads the counted rows; C2/C3 have nothing to audit without tiers) |
| CONCEPT-5 | One result, three counts: the verdict says 273, the count is 266, the proposal says all 273 "count toward your result" | definite bug | medium | fixed here (with LOOP-15, LISTINGS-3, UI-1) |
| CONCEPT-6 | The memo check calls a correct count a contradiction on tables without tiers | definite bug | medium | fixed here (with LOOP-2) |
| CONCEPT-7 | A `.eu` address is read as the country "EU", so the Slovak seed portal can never deliver a row | definite bug | medium | fixed here |
| CONCEPT-8 | The brief text of a supplier list still asks for "single listing pages for sale" in the asked country | definite bug | medium | fixed here |
| CONCEPT-9 | A seller's word becomes a car model: "prodam citroen" passes any Citroën as a hatchback and values them together | definite bug | medium | fixed here (a stricter rule than the audit's, which broke a real Skoda case) |
| CONCEPT-10 | A limit written with a thousands separator is not read | likely bug | medium | next PR |
| CONCEPT-11 | The brief tells the models that code-checked clauses are "not modelled", and one-word clauses vanish | design flaw | low | next PR |
| CONCEPT-12 | Units and nouns from the plot research on every other list | ui | low | next PR |
| CONCEPT-13 | C19 reads the code's own verdict text and the user's own ask as memo counts | likely bug | low | next PR |

## Tree and research loop (LOOP)

| Id | Finding | Class | Severity | Status |
|---|---|---|---|---|
| LOOP-1 | A finding made only of assumptions, with zero sources, is graded "supported" | definite bug | high | fixed here |
| LOOP-2 | The memo check marks the table's own kept count as "contradicting the verified record" | definite bug | high | fixed here |
| LOOP-3 | A parent is not rolled up again when a child is re-researched after a failure or a drift downgrade | definite bug | medium | fixed here |
| LOOP-4 | The last attempt overwrites a better earlier attempt | design flaw | medium | next PR |
| LOOP-5 | All three list researches are typed "estimate" or "plan", so the memo gets the wrong rule | definite bug | medium | fixed here |
| LOOP-6 | An outage during the meaning check is stored as a finished check: verified pieces drop to supported and are never rechecked | definite bug | medium | fixed here |
| LOOP-7 | The second meaning vote can come from the author's own provider (B5) | definite bug | medium | fixed here |
| LOOP-8 | The drift monitor re-researches freshly settled pieces against a baseline that never moves; champion/challenger never runs | design flaw | medium | next PR |
| LOOP-9 | The stop flag is never cleared, is accepted on an idle research, and is only read between stages | definite bug | medium | fixed here (part: stop flag cleared, idle stop refused, checked between nodes and pages; rest next PR: no stop check inside decomposition, concept validation or the memo call) |
| LOOP-10 | A rollup is one fast call with no retry; one failed self-check puts a driver below its settled children | design flaw | medium | next PR |
| LOOP-11 | "Not an answer" is matched anywhere in the answer, so a concrete answer with an honest caveat fails | likely bug | medium | next PR |
| LOOP-12 | The exported report prints the model's own confidence next to the code's verdict | ui | low | next PR |
| LOOP-13 | A failed or pending piece scores higher than a weak or unsupported one in the evidence probability | definite bug | low | fixed here |
| LOOP-14 | Pieces "covered by code" are listed as "Research further" and count as not researched | definite bug | low | fixed here |
| LOOP-15 | The headline says 273 results fit; 266 fit and are confirmed (row A1) | definite bug | low | fixed here (with CONCEPT-5) |

## Listings and the result table (LISTINGS)

| Id | Finding | Class | Severity | Status |
|---|---|---|---|---|
| LISTINGS-1 | The acceptance kind check is waived for every swept row, so an engine sold alone is result #1 and passes every check | definite bug | high | deferred: reproduced ("Motor dacia sandero" passes), but removing the sweep waiver does not fix it; needs a decision on which words or page facts mark a part sold alone and whether swept rows get a page check |
| LISTINGS-2 | A model-voted list of 16 model names is used as a closed whitelist: 2,454 of 3,257 car rows go to "to check" | design flaw | high | next PR |
| LISTINGS-3 | The headline says 273 plots fit while 266 count, and "332 confirmed" mixes tiers | definite bug | high | fixed here (part: headline counts confirmed fits; deferred: found ≠ kept + to check + screened on a tiered table, needs a decision on what "kept" means there) |
| LISTINGS-4 | The to-check list is cut to 100 rows before it is stored: 2,442 car rows exist nowhere | design flaw | medium | next PR |
| LISTINGS-5 | Merging two extraction methods pairs one method's area with the other's unit: 6,500 m² becomes 6,500 ha | definite bug | medium | fixed here |
| LISTINGS-6 | Seed portals are dropped by comparing a EUR cap with the user's number in any currency, and by a fixed 20,000 in the URL | definite bug | medium | fixed here (part: cap compared in the portal's currency; deferred: seed URLs above 20,000 EUR, unverified URL shapes) |
| LISTINGS-7 | When exchange rates cannot be fetched, every foreign-currency listing is screened out as "price outside" | likely bug | medium | next PR |
| LISTINGS-8 | Different bazos ads share one dedupe key when their titles end in the same number | definite bug | medium | fixed here (a path-id rule; the audit's rule merged different autoscout24 ads) |
| LISTINGS-9 | A page the site refused or removed is fetched again through the Jina reader | likely bug | medium | next PR |
| LISTINGS-10 | The price-in-range check compares an unconverted listing price with the asked range when the page shows no amount | definite bug | low | fixed here |
| LISTINGS-11 | The pitch count ignores the area unit: a 4 dönüm plot shows "~0 pitches" | definite bug | low | fixed here |
| LISTINGS-12 | Forum comments are read as listings: the only Vietnam row is a post dated "1/7/26" | likely bug | low | next PR |
| LISTINGS-13 | Rows whose distance cannot be measured stay kept and count | design flaw | low | next PR |
| LISTINGS-14 | The parcel lookup reads listing pages with a Safari User-Agent and outside the shared page cache | uncertainty | low | next PR |

## Self-improvement, learning, routing, verifier (LEARNING)

| Id | Finding | Class | Severity | Status |
|---|---|---|---|---|
| LEARNING-1 | The second measurement re-reads cached pages, so the measured noise is always 0 (row D2 is back) | definite bug | high | fixed here |
| LEARNING-2 | One bad verifier run replaced every confirmation: 353 → 47 confirmed in two minutes, result 100% → 38% for 47 minutes | design flaw | high | next PR |
| LEARNING-3 | A half-written or unreadable verifier record is read as "nothing confirmed"; `complete` and `inputs` are never checked (row C-2) | definite bug | medium | fixed here (part: incomplete records never replace a complete one; deferred: per-row input check, signature reset after a failed run) |
| LEARNING-4 | A provider that times out is treated as "offline": one call retries 22 times over 108 minutes and the slow-provider bench is undone | definite bug | high | fixed here |
| LEARNING-5 | The first four real gains of every research are thrown away, then refused as repeats; the plateau rule ends the loop before a fifth can come | design flaw | medium | next PR |
| LEARNING-6 | The ledger refuses changes as "never kept" that were kept minutes earlier on the same piece type | definite bug | medium | fixed here |
| LEARNING-7 | A loop the user stopped is resumed after a restart (row D8 does not hold for loops) | definite bug | medium | fixed here |
| LEARNING-8 | The watchdog never revives a crashed loop when the loop before it was stopped by the user; a running loop shows "stopped by user" | definite bug | medium | fixed here (with UI-3) |
| LEARNING-9 | Proposals that were never tested count as futile trials: pieces rest for 6 h and the loop "plateaus" on refusals | likely bug | medium | next PR |
| LEARNING-10 | The verifier confirms a plot on the app's own map point, and "price on the page" is any number on the page near the app's price | design flaw | medium | next PR |
| LEARNING-11 | The reviewer can be the author's own provider, and nothing records who reviewed (row B5) | design flaw | medium | next PR |
| LEARNING-12 | A scoped loop with nothing to try spins: about 12,000 project saves per minute until the deadline | definite bug | low | fixed here |
| LEARNING-13 | SambaNova's daily limit is stated as 20 requests; it answered 38 of 38 on one day and is ranked as "spent" at 190% (row D3) | definite bug | low | fixed here |
| LEARNING-14 | The heap guard "restarts gracefully" by exiting, also when nothing will start the app again | likely bug | low | next PR |

## User interface and API (UI)

| Id | Finding | Class | Severity | Status |
|---|---|---|---|---|
| UI-1 | The Results headline counts plots the verifier has not confirmed (A1 is back) | definite bug | high | fixed here (with CONCEPT-5) |
| UI-2 | Any web page open on the same computer can drive the app's API (no Origin or Host check on loopback) | definite bug | high | fixed here (Origin and loopback Host checks; JSON content type not required) |
| UI-3 | A stale "loop active" flag locks the page in "improving", and "Join" starts a full run | definite bug | high | fixed here (with LEARNING-8) |
| UI-4 | The implementer you click for an app change is thrown away by the server | definite bug | medium | fixed here |
| UI-5 | "2546 to check" opens a list of 104, and the rest cannot be seen or exported | ui | medium | next PR |
| UI-6 | Every live update sends and redraws the whole research: 6.4 MB per push on the plots research | design flaw | medium | next PR |
| UI-7 | "Reposts" merges different plots, and the sidebar hides researches with the same question | likely bug | medium | next PR |
| UI-8 | One table for every kind: the car list shows ten empty plot columns and a plot-only details panel | ui | medium | next PR |
| UI-9 | A share link can wipe the research, although the dialog says guests "run it and add pieces" | design flaw | medium | next PR |
| UI-10 | Times are shown in UTC in some places and local time in others, without a mark | ui | low | next PR |
| UI-11 | "The question itself is not settled yet" is shown even when the memo says GO | definite bug | low | fixed here |
| UI-12 | "Delivered (3)" lists items that failed the checks exactly like the one that passed | ui | low | next PR |
| UI-13 | Status codes: internal errors answer 400 with the raw message, unknown ids answer 200 | likely bug | low | next PR |
| UI-14 | Escaping: no exploitable injection found, three weak spots remain | uncertainty | low | next PR |

## Spec for the next full audit fix PR

The items below are in order of severity, then confidence. Each id links to its full entry in the area appendix: where, evidence, fix and test.

1. **LISTINGS-1** (high, definite bug): The acceptance kind check is waived for every swept row, so an engine sold alone is result #1 and passes every check. _deferred: reproduced ("Motor dacia sandero" passes), but removing the sweep waiver does not fix it; needs a decision on which words or page facts mark a part sold alone and whether swept rows get a page check_. See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
2. **LEARNING-2** (high, design flaw): One bad verifier run replaced every confirmation: 353 → 47 confirmed in two minutes, result 100% → 38% for 47 minutes. See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
3. **LISTINGS-2** (high, design flaw): A model-voted list of 16 model names is used as a closed whitelist: 2,454 of 3,257 car rows go to "to check". See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
4. **LOOP-4** (medium, design flaw): The last attempt overwrites a better earlier attempt. See [LOOP.md](engine-audit-2026-11-12/LOOP.md).
5. **LISTINGS-4** (medium, design flaw): The to-check list is cut to 100 rows before it is stored: 2,442 car rows exist nowhere. See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
6. **LEARNING-5** (medium, design flaw): The first four real gains of every research are thrown away, then refused as repeats; the plateau rule ends the loop before a fifth can come. See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
7. **UI-5** (medium, ui): "2546 to check" opens a list of 104, and the rest cannot be seen or exported. See [UI.md](engine-audit-2026-11-12/UI.md).
8. **UI-8** (medium, ui): One table for every kind: the car list shows ten empty plot columns and a plot-only details panel. See [UI.md](engine-audit-2026-11-12/UI.md).
9. **LOOP-8** (medium, design flaw): The drift monitor re-researches freshly settled pieces against a baseline that never moves; champion/challenger never runs. See [LOOP.md](engine-audit-2026-11-12/LOOP.md).
10. **LOOP-11** (medium, likely bug): "Not an answer" is matched anywhere in the answer, so a concrete answer with an honest caveat fails. See [LOOP.md](engine-audit-2026-11-12/LOOP.md).
11. **LEARNING-11** (medium, design flaw): The reviewer can be the author's own provider, and nothing records who reviewed (row B5). See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
12. **UI-6** (medium, design flaw): Every live update sends and redraws the whole research: 6.4 MB per push on the plots research. See [UI.md](engine-audit-2026-11-12/UI.md).
13. **UI-9** (medium, design flaw): A share link can wipe the research, although the dialog says guests "run it and add pieces". See [UI.md](engine-audit-2026-11-12/UI.md).
14. **CONCEPT-10** (medium, likely bug): A limit written with a thousands separator is not read. See [CONCEPT.md](engine-audit-2026-11-12/CONCEPT.md).
15. **LOOP-10** (medium, design flaw): A rollup is one fast call with no retry; one failed self-check puts a driver below its settled children. See [LOOP.md](engine-audit-2026-11-12/LOOP.md).
16. **LISTINGS-7** (medium, likely bug): When exchange rates cannot be fetched, every foreign-currency listing is screened out as "price outside". See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
17. **LEARNING-9** (medium, likely bug): Proposals that were never tested count as futile trials: pieces rest for 6 h and the loop "plateaus" on refusals. See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
18. **LEARNING-10** (medium, design flaw): The verifier confirms a plot on the app's own map point, and "price on the page" is any number on the page near the app's price. See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
19. **UI-7** (medium, likely bug): "Reposts" merges different plots, and the sidebar hides researches with the same question. See [UI.md](engine-audit-2026-11-12/UI.md).
20. **LISTINGS-9** (medium, likely bug): A page the site refused or removed is fetched again through the Jina reader. See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
21. **CONCEPT-12** (low, ui): Units and nouns from the plot research on every other list. See [CONCEPT.md](engine-audit-2026-11-12/CONCEPT.md).
22. **LOOP-12** (low, ui): The exported report prints the model's own confidence next to the code's verdict. See [LOOP.md](engine-audit-2026-11-12/LOOP.md).
23. **UI-10** (low, ui): Times are shown in UTC in some places and local time in others, without a mark. See [UI.md](engine-audit-2026-11-12/UI.md).
24. **CONCEPT-11** (low, design flaw): The brief tells the models that code-checked clauses are "not modelled", and one-word clauses vanish. See [CONCEPT.md](engine-audit-2026-11-12/CONCEPT.md).
25. **UI-12** (low, ui): "Delivered (3)" lists items that failed the checks exactly like the one that passed. See [UI.md](engine-audit-2026-11-12/UI.md).
26. **UI-13** (low, likely bug): Status codes: internal errors answer 400 with the raw message, unknown ids answer 200. See [UI.md](engine-audit-2026-11-12/UI.md).
27. **CONCEPT-13** (low, likely bug): C19 reads the code's own verdict text and the user's own ask as memo counts. See [CONCEPT.md](engine-audit-2026-11-12/CONCEPT.md).
28. **LISTINGS-12** (low, likely bug): Forum comments are read as listings: the only Vietnam row is a post dated "1/7/26". See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
29. **UI-14** (low, uncertainty): Escaping: no exploitable injection found, three weak spots remain. See [UI.md](engine-audit-2026-11-12/UI.md).
30. **LISTINGS-13** (low, design flaw): Rows whose distance cannot be measured stay kept and count. See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).
31. **LEARNING-14** (low, likely bug): The heap guard "restarts gracefully" by exiting, also when nothing will start the app again. See [LEARNING.md](engine-audit-2026-11-12/LEARNING.md).
32. **LISTINGS-14** (low, uncertainty): The parcel lookup reads listing pages with a Safari User-Agent and outside the shared page cache. See [LISTINGS.md](engine-audit-2026-11-12/LISTINGS.md).

### Remaining parts of findings fixed in part here

- **LOOP-9**: no stop check runs inside decomposition, concept validation or the memo call, so a stop there waits for the stage to end.
- **LISTINGS-3**: on a tiered table, found ≠ kept + to check + screened out. `keptCount` means "fits" there and the stored rows are capped at 1,000. Decide what "kept" means on a tiered table, then make the totals add up.
- **LISTINGS-6**: the pisos.com and imovirtual.com seed URLs carry a fixed 20,000 EUR price filter. Build them from the asked maximum once the URL shapes are verified against live pages.
- **LEARNING-3**: the verifier record holds no per-row inputs, so a confirmation cannot be matched to the row state it checked. A failed verifier run also leaves the signature set, so the run is not retried. Both need a record-format decision, and the retry also needs a limit.

### New items found while fixing (not in the five reports)

- **NEW-1** (listings, definite bug): the card reader parses "0,775Ha" as 775 ha (decimal comma before a unit).
- **NEW-2** (listings, definite bug): two pisos.com ads still share a dedupe key (ids like `55009800234_108300`).
- **NEW-3** (loop, definite bug): `src/research/improve.mjs` sets the loop's `stopReason` once, before the passes start, so a loop the user stops in the middle of a pass is recorded as "time limit reached".
- **NEW-4** (concept, transient): a stored car model keeps the exclusion word "kola" until its next calibration. A table rebuild before then screens out two real kept cars ("Kia Rio … 2x kola", "Honda Civic … Al kola 17"). Recalibrate 0c750f, or apply the full-price rule (CONCEPT-2) when the words are used.
- **NEW-5** (loop, follow-up to LOOP-1): 8 of 31 stored leaves rest only on assumptions. 6 of them would drop to weak when researched again, among them two "verified" plot pieces (b7772e D17, whose only "quote" is a captcha page, and D8.1.1). Stored grades change only on a re-research, so re-research these pieces.
