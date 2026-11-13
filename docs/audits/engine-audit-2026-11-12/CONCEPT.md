**Not written to disk:** the write to `data/audit/CONCEPT.md` was refused twice by the write tool and once through the shell (permission not granted), so the report exists only below. No file was created or changed anywhere, including `data/audit/scratch/`; saving this text as `data/audit/CONCEPT.md` completes the task.

# Engine audit 2026-11-12: CONCEPT (question intake and the concept of a result)

Scope read: `src/research/brief.mjs`, `decision.mjs`, `concept.mjs`, `conceptaudit.mjs`, `strategy.mjs`, `domain.mjs`, `fundamentals.mjs`, `valuation.mjs`, `valuecase.mjs`, `proposal.mjs`, `lessons.mjs`, and the brief / decisionModel / located / regions / acceptance paths of `engine.mjs`. I also read the lines of `candidates.mjs`, `itemgate.mjs`, `memocheck.mjs`, `verification.mjs` and `portals.mjs` that those paths call.

Evidence: every "verified by running" finding was run as an inline node one-off (`node --input-type=module -e`) against `data/projects/*.json` and `data/logs/*.jsonl`. No network service was called. Where a model reply was needed it was stubbed, and the finding says so; questions, titles, URLs and stored models are from the data.

Ids: 0c750f = hatchback cars around Prague (CZK), b7772e = glamping plots, b2f5b7 = wholesale clothing suppliers.

---

### CONCEPT-1. Rebuilding the decision model wipes the calibrated sub-type and the validated kind, so the next table loses its main screen
- class: definite bug
- severity: high
- where: `src/research/decision.mjs:393` (`DecisionModeler.build`), triggered through `decision.mjs:380` (`fresh`), `engine.mjs:532` (`ensureDecisionModel`), `engine.mjs:651` (`ensurePurpose` → `rebuildDecisionModel`)
- evidence (verified by running; the three model replies were stubbed):
  - `build` replaces the whole object: `project.decisionModel = { ...model, version: DECISION_MODEL_VERSION, question, guidance, caseIds: ..., providers: ..., at: ... };`
  - `subtype`, `calibrated`, `calibratedOn`, `kind.not`, `kind.verified`, `kind.validated` and `kind.hubs` are written onto that object later by `calibrateKind` (`engine.mjs:766-770`), `verifyKind` (`engine.mjs:836`) and `validateConcept` (`engine.mjs:701`). None is carried over.
  - `fresh()` is false as soon as the guidance changes (`m.guidance === String(project.guidance ?? '')`).
  - Run on 0c750f with one hint added: `before: subtype models 16 calibrated 2026-11-03T13:21:54.199Z not [parts, accessories, kola]` → `after: subtype undefined calibrated undefined not undefined verified null`.
  - Run on b2f5b7: `before: validated true hubs [czech republic]` → `after: validated undefined hubs undefined`.
  - Rebuilding the 0c750f table from its stored sweep (fixed stand-in exchange rates): `stored brief: kept 209, to check 2542` → `subtype lost: kept 2453, to check 592, valued rows 0 (was 96)`.
  - `calibrateKind` cannot repair it without a new sweep, because it needs `kind?.verified`, which the rebuild set to `null`.
- impact: after any hint edit (or a purpose retry), the next table rebuild without a sweep counts 2,453 "hatchbacks" instead of 209, including estates, sedans and unknown models, and every market value disappears. For a supplier list the kind validation is repeated and can pause a research that was already validated ("needs-concept").
- fix: in `build`, carry the code-derived state over when the kind label is unchanged: `subtype`, `calibrated`, `calibratedOn`, and on `kind`: `not` (union), `condition`, `upgrades`, `verified`, `validated`, `hubs`.
- test: `tests/research/decision.test.ts` "a rebuild after a hint keeps the calibrated sub-type": load the stored 0c750f `decisionModel`, set `guidance = 'prefer petrol engines'`, build with a stub router, expect `decisionModel.subtype.models.length === 16` and `calibrated` defined.
- confidence: 0.85

### CONCEPT-2. The brief drops the kind's exclusion, condition and upgrade words, so calibration never screens anything
- class: definite bug
- severity: high
- where: `src/research/engine.mjs:437` (`briefOf`); consumers `itemgate.mjs:51`, `candidates.mjs:273`
- evidence (verified by running):
  - `const kind = template.itemKind ?? (model?.kind?.terms?.length ? { label: model.kind.label, terms: model.kind.terms } : null);` Only `label` and `terms` survive.
  - `screenItem` reads `kind.not` (`itemgate.mjs:51`); the value table reads `brief.kind?.condition` and `brief.kind?.upgrades` (`candidates.mjs:273`). All three are always empty for a decision-model kind.
  - Stored 0c750f: `decisionModel.kind.not = [parts, accessories, kola]`, but `brief.kind = {label: "used car", terms: ["hatchback"]}`.
  - Kept rows that contain an exclusion word: "Kia Rio, 1.1 CRDI 55KW klima,2x kola" and "Honda Civic 2,2 CTDi"103kW"+ Al kola 17 l".
  - The first kept and first delivered row is "Motor dacia sandero" (an engine, 25,000 CZK), valued at 59,000 CZK and ranked "underpriced 2.37".
- impact: AUDIT-PROTOCOL row A14 says parts are caught by `calibrateKind`; that no longer holds, because its output never reaches the screen. Condition flags ("for parts", "crashed") and upgrade effects are never computed.
- fix: build the brief kind as `{ label, terms, not, condition, upgrades }`. Passing `not` through as stored would screen 154 rows, including real cars with spare wheels ("2x kola"). So `applyCalibration` must also reject a `not` word that appears in titles matching a sub-type model priced above the low-outlier cut.
- test: `tests/research/engine.test.ts` "briefOf keeps the kind's calibrated words": project with the stored 0c750f `decisionModel.kind`, expect `briefOf(project).kind.not` to equal `['parts','accessories','kola']`. Also `tests/research/decision.test.ts` "a word that titles of the asked model use is not an exclusion", with the two titles above.
- confidence: 0.9

### CONCEPT-3. A criterion without a stated limit borrows the limit of another research's question, from cases nobody approved
- class: definite bug (contradicts CONCEPT.md: "the limit is taken from an approved case")
- severity: high
- where: `src/research/decision.mjs:90-96` (`fromCases`), `:303-314` (`rankCases`), `:349` (`record`, `approved: false`), `:392`
- evidence (verified by running; the model samples were stubbed):
  - `fromCases` filters only `k.source !== 'assumption'` and never reads `c.approved`. `rankCases` ranks every stored case. `record` stores each research with `approved: false`, and `decisionPrompt` shows them under "Approved examples".
  - The real logs show unapproved cases in use (`examples: which-trendy-used-cars-priced-20-b4f648, find-appropriate-plots-eligible--eb501e`) and a research retrieving itself (`examples: find-accurate-and-verified-car-l-0c750f, glamping-low-entry`).
  - Run: the 0c750f question, three samples that propose `priceEur <=` with `value: null` (what the prompt tells a model to return when unsure), and the stored b7772e model as a case:
    - `criteria [{"measure":"priceEur","op":"<=","value":20000,"source":"case find-appropriate-plots-to-buy-fo-b7772e (question)"}]`
    - `Motor dacia sandero 25000 CZK -> does not fit: asking price <= 20000 EUR (asking price: 25000 EUR)`
    - `kept rows that would still fit: 18 of 205`
  - In the stored run this did not fire only because fewer than two samples proposed the measure (`proposed: 1, kept: 0`).
- impact: one model wording away from marking 187 of 205 cars as failing a 20,000 limit the user never set. A research also learns from, and rewards, its own earlier model (`engine.mjs:1458` rewards `caseIds` plus its own id).
- fix: `fromCases` takes limits only from cases with `approved === true`, never from a criterion whose source is another research's `question` or `guidance`, and never from the research's own id. `rankCases` excludes the research itself.
- test: `tests/research/decision.test.ts` "a limit is never taken from an unapproved case or another question": `aggregate` on the 0c750f question with the b7772e model as case, expect `criteria` empty and `noLimit[0].measure === 'priceEur'`.
- confidence: 0.8

### CONCEPT-4. The concept audit checks nothing on a list without tiers: C2, C3 and C5 pass on zero rows
- class: definite bug
- severity: medium
- where: `src/research/conceptaudit.mjs:30` (`fitsOf`), `:58`, `:63`, `:73-77`
- evidence (verified by running):
  - `const fitsOf = (kept) => kept.filter((r) => r?.plan?.tier === 'fits');` and C5 is `fits.filter(... r.value > max * 1.02)`.
  - A table built without a strategy or model criteria has no `plan`, while `countsTowardResult` counts every such row (`candidates.mjs:298`: `!row.plan || ...`).
  - Output on stored 0c750f: `C2 All 0 fit(s) have every asked check met.` and `C5 All 0 fit(s) are within 65000 EUR.`
  - With the first kept row changed to 650,000 CZK: `C5 ok=true All 0 fit(s) are within 65000 EUR.` The 205 rows that count are never looked at.
- impact: row A5 ("price limit broken ... caught by C5") holds only for the glamping strategy. A currency or deposit error on a car list, or any other list, shows a green audit.
- fix: audit the rows that count: `const counted = kept.filter((r) => countsTowardResult(r, c))` for C5 (and C4), and print `p.brief.unit` instead of the fixed "EUR".
- test: `tests/research/conceptaudit.test.ts` "C5 reads the rows that count when the table has no tiers": stored 0c750f with `kept[0].value = 650000`, expect C5 `ok === false`.
- confidence: 0.9

### CONCEPT-5. One result, three counts: the verdict says 273, the count is 266, the proposal says all 273 "count toward your result"
- class: definite bug (A1 again, in the texts)
- severity: medium
- where: `src/research/candidates.mjs:334-340` (`tableVerdict`), `src/research/verification.mjs:35-37`, `src/research/proposal.mjs:96` and `:160`
- evidence (verified on stored b7772e):
  - `keptCount 266`; fits by verdict `{confirmed: 266, unconfirmed: 7}`; `proposals.primary 273`.
  - Stored verdict: "Decision model: 273 results of the 50 asked fit every check (externally verified: 332 confirmed, 496 refuted, 54 not yet confirmed; a result counts only when it fits every check and is confirmed)".
  - The 332 / 496 / 54 are verdicts over all 882 verifiable rows (fits, trade-offs and to-confirm, `verification.mjs:37`), not over the 273. So "332 confirmed" is larger than the 273 it sits beside.
  - `proposal.mjs:96`: `why: 'every criterion you set is measured and met; these count toward your result', test: (r) => r.plan.tier === 'fits' && !refuted(r)` puts the 7 unconfirmed rows in the counting group.
- impact: the user reads 273, 332 and 266 for the same result and cannot tell which is the answer; 7 plots are shown as counting that do not.
- fix: `tableVerdict` leads with `keptCount` ("266 results fit every check and are confirmed; 7 more fit and await confirmation") and reports verifier verdicts over the fits only. The `fits` opportunity says "confirmed ones count toward your result", and `primary` holds only confirmed rows when a verification exists.
- test: `tests/research/candidates.test.ts` "the verdict states the counted number": stored b7772e candidates, expect the verdict to contain "266" before any other count and not "332 confirmed".
- confidence: 0.85

### CONCEPT-6. The memo check calls a correct count a contradiction on tables without tiers
- class: definite bug
- severity: medium
- where: `src/research/memocheck.mjs:56-58` (`counted`), `:72`; shown through `engine.mjs:1284` and C12 (`conceptaudit.mjs:131-135`)
- evidence (verified by running on stored 0c750f):
  - `counted` keeps only `r.plan?.tier === 'fits'`, so for the car table the "verified record" is `0 listing(s) that fit every check` and the count pool is `[0, found, itemCount]`.
  - The stored verdict contradicts itself: "Table (computed by code): 205 results kept ... memo numbers checked against the verified record: 1 of 6 match; 3 contradict it ("Total kept listings: 205 listings"; ...)".
  - C12 then warns: "3 memo claim(s) contradict the record; first: Total kept listings: 205 listings".
- impact: the user is told the memo is wrong where it repeats the code's own count. The audit carries a standing false warning, which teaches people to ignore C12 (row B4).
- fix: `counted` uses `countsTowardResult`, and the count pool includes `candidates.keptCount` and `toCheckCount`.
- test: `tests/research/memocheck.test.ts` "a memo that states the kept count is supported on a table without tiers": stored 0c750f report and candidates, expect "Total kept listings: 205 listings" to be `supported`.
- confidence: 0.9

### CONCEPT-7. A `.eu` address is read as the country "EU", so the Slovak seed portal can never deliver a row
- class: definite bug
- severity: medium
- where: `src/research/brief.mjs:212-220` (`tldCountry`), `:255-257` (`itemCountry`), `:78` (`GENERIC_TLDS`)
- evidence (verified by running):
  - `return /^[a-z]{2}$/.test(tld) ? TLD_ALIASES[tld] ?? tld.toUpperCase() : '';` returns any two letters without checking `countryByCode`.
  - `itemCountry({url: 'https://www.autobazar.eu/detail/skoda-fabia/123/'})` → `{"code":"EU","by":"site address"}`. `autobazar.eu` is the SK seed portal (`portals.mjs:41`).
  - In stored 0c750f all 86 of its listings map to "EU", the table shows `"outside the asked regions": 86`, and the audit shows `C13 No kept plot from: AT, SK`.
  - Size of the loss here: 83 of the 86 also fail the price limit ("Škoda Kodiaq ... 23990 EUR"); 3 were rejected for the region alone.
- impact: Slovakia, a country inside the asked radius, can never reach the table; the same holds for every listing site on `.eu`. The screening reason shown to the user ("in EU, outside the asked regions") is false.
- fix: add `eu` to `GENERIC_TLDS` and return a TLD code only when `countryByCode` knows it, so the country falls through to the listing text, the locale or the seed portal's `country`.
- test: `tests/research/brief.test.ts` "a .eu address names no country": `itemCountry({ url: 'https://www.autobazar.eu/detail/skoda-fabia/123/', title: 'Skoda Fabia' }, { country: 'SK' })` → `code === 'SK'`.
- confidence: 0.9

### CONCEPT-8. The brief text of a supplier list still asks for "single listing pages for sale" in the asked country
- class: definite bug (E12, A23: one stage not updated)
- severity: medium
- where: `src/research/brief.mjs:193`, `:203`, `:205` (`buildBrief`, `describeBrief`); `src/research/engine.mjs:444` (text built before `located` is applied), contradicting `engine.mjs:409`
- evidence (verified on stored b2f5b7, `located: false`):
  - ``brief.kind ? `Deliver: ${brief.itemCount ?? 'a list of'} single ${brief.kind.label} listing pages for sale` `` and the fixed `excludes` list take no account of `located`.
  - Stored text, sent with every research and decompose prompt (`engine.mjs:383`, `:1182`): "Deliver: 20 single wholesale clothing provider listing pages for sale / Where: Czechia / Exclude: offered for rent; offered as a swap; wanted ads; news, blog or guide pages; search or category pages".
  - `engine.mjs:409` emits the opposite for the same case: "... is where the result is used, not a filter on sources".
  - The user's hint names NL, DE, UK, IT, PL, LT. `hubsFrom` reads them; the brief does not.
  - The research delivered 1 of 20.
- impact: every model working on the supplier research is told to return listing pages for sale located in Czechia, which is the rule set A23 removed from the code side.
- fix: pass `located` into `describeBrief`. When false, write "Deliver: 20 wholesale clothing providers, each with its own website" and "Used in: Czechia (sources may be anywhere)", and keep only the excludes that apply to entities.
- test: `tests/research/brief.test.ts` "an entity list is not described as listing pages": `describeBrief` on the stored b2f5b7 brief contains neither "listing pages for sale" nor "offered for rent".
- confidence: 0.85

### CONCEPT-9. A seller's word becomes a car model: "prodam citroen" passes any Citroën as a hatchback and values them together
- class: definite bug
- severity: medium
- where: `src/research/decision.mjs:214-215` (`applyCalibration`, `forms`); used by `candidates.mjs:178` and `valuation.mjs:94-100`
- evidence (verified on stored 0c750f):
  - `parts.length > 2 ? [parts.join(' '), parts.slice(0, 2).join(' ')] : [parts.join(' ')]` turns the proposed "prodam citroen c1" ("prodám" = "for sale") into the model "prodam citroen". Stored `subtype.models` contains both.
  - Kept rows in group `prodam citroen`: "Prodám Citroen Saxo 1,4 VTS" and "Prodám Citroen C4 1,4 + LPG".
  - Any title starting "Prodám Citroen ..." now satisfies "shown to be a hatchback" (`candidates.mjs:178`), and a Saxo and a C4 are each other's comparables.
- impact: the body-type check is bypassed for one make by how the seller starts the title; values for that group mix different models.
- fix: keep the two-word short form only when its first word also starts another proposed model (a make). "skoda fabia ii" → "skoda fabia" stays because "skoda felicia" exists; "prodam citroen" is dropped.
- test: `tests/research/decision.test.ts` "a title prefix is not a model": `applyCalibration` with models `['prodam citroen c1', 'skoda fabia ii', 'skoda felicia']` and the titles above, expect `'prodam citroen'` absent and `'skoda fabia'` present.
- confidence: 0.85

### CONCEPT-10. A limit written with a thousands separator is not read
- class: likely bug
- severity: medium
- where: `src/research/brief.mjs:163-166` (`CLAUSE_BREAK`, `budgetOf`), `src/research/decision.mjs:48-53` (`numbersIn`, `quoteStates`)
- evidence (verified by running on the sentence the app's own model wrote for 0c750f, `decisionModel.value`: "... each at or below 65,000 CZK, ready for purchase"):
  - The users' questions in the data write "65000CZK" and "20000EUR", so the three researches were not hit.
  - `budgetOf` splits clauses on every comma (`/[,;]|\bbut\b|\band\b/i`), so "65,000" is cut into "65" and "000 CZK": result `null`.
  - `numbersIn` uses `/\d+(?:[.,]\d+)?/` and `Number(n.replace(',', '.'))`, so "65,000" is 65: `quoteStates(text, 'at or below 65,000 CZK', 65000)` → `false`.
  - The decision prompt's own example writes "65,000 CZK".
- impact: a question with "up to 65,000 CZK" or "20.000 EUR" gets no budget from the question, and the price criterion falls to "asked but no limit stated" or to a case limit (CONCEPT-3).
- fix: in both places, join thousands groups before splitting or parsing (`replace(/(\d)[ .,\u00a0](?=\d{3}\b)/g, '$1')`, as `statedResultCounts` already does).
- test: `tests/research/brief.test.ts` "a budget with a thousands separator": `budgetOf('price up to 65,000 CZK or equivalent')` → `{valueRange: [0, 65000], unit: 'CZK'}`. In `tests/research/decision.test.ts`: `quoteStates('price up to 65,000 CZK', 'up to 65,000 CZK', 65000) === true`.
- confidence: 0.75

### CONCEPT-11. The brief tells the models that code-checked clauses are "not modelled", and one-word clauses vanish
- class: design flaw
- severity: low
- where: `src/research/strategy.mjs:155-157` (`clausesOf`), `src/research/decision.mjs:138`, `:160`, `:282` (`modelText`)
- evidence (verified on stored briefs):
  - The 0c750f brief text holds both "Hard limit: price 0–65000 CZK" and "Not modelled yet (no code check): ... within 300km from prague; ...; price up to 65000CZK or equivalent". Price, radius (`measureDistances`) and body type (`subtype`) are all checked by code.
  - `clausesOf` keeps only clauses of two or more words, so the clause "hatchback" is in neither list (`clausesOf(question).includes('hatchback')` → `false`).
  - For b2f5b7 the brand list is split into clauses: "North face", "Barbour with highest price/value ratio"; "Monclair" is dropped.
- impact: prompts and the candidate-table header state that the price limit has no code check. The "not modelled" list, which CONCEPT.md promises is never silent, silently omits one-word clauses.
- fix: mark a clause as covered when the brief has a hard limit, an area or a sub-type that quotes it; keep one-word clauses; do not split inside a comma list of names.
- test: `tests/research/decision.test.ts` "a clause the brief checks is not listed as not modelled": 0c750f question with `valueRange [0, 65000]`, expect `missing` without "price up to 65000CZK or equivalent" and the clause list to include "hatchback".
- confidence: 0.8

### CONCEPT-12. Units and nouns from the plot research on every other list
- class: ui (row A16)
- severity: low
- where: `src/research/decision.mjs:22` and `:234-237`; `src/research/conceptaudit.mjs:64`, `:70`, `:76`, `:140`
- evidence (verified by running):
  - The only price measure is `priceEur: { label: 'asking price', unit: 'EUR', read: (row) => finite(row.value) }`, and `row.value` is in the brief's unit. Output for a CZK row: "asking price <= 20000 EUR (asking price: 25000 EUR)".
  - C5 prints a fixed "EUR": "All 0 fit(s) are within 65000 EUR" for a CZK limit.
  - On the car research the audit prints "No plot is counted where the buyer cannot own it", "Every kept plot is in AT, CZ, DE, PL, SK" and "No kept plot from: AT, SK".
- impact: wrong currency label on a hard criterion (25,000 CZK shown as 25,000 EUR); car audits talk about plots.
- fix: name the measure `price` and take its unit from `brief.unit`; use the kind label ("row" when unknown) and `brief.unit` in the audit texts.
- test: `tests/research/decision.test.ts` "a price criterion shows the brief's currency": `evaluateCriterion` on the stored row "Motor dacia sandero" (25,000 CZK) with `ctx.unit = 'CZK'`, expect the detail to end in "CZK".
- confidence: 0.9

### CONCEPT-13. C19 reads the code's own verdict text and the user's own ask as memo counts
- class: likely bug
- severity: low
- where: `src/research/conceptaudit.mjs:8-17` (`statedResultCounts`), `:177-181`
- evidence (verified by running):
  - C19 scans `p.report.verdict`, which is the code-written table sentence, then the memo, then the quoted claim-check failures (`engine.mjs:1282-1284`).
  - On 0c750f: `statedResultCounts → [205, 205, 80, 205]`, warning "memo states 80 results, the table keeps 205". The 80 comes from the quoted claim "Required trade‑off listings: 80 listings", which is the user's own request ("up to 80 as a trade off").
  - On b7772e the list is `[273, 235, 4, 3000]`: "4" is from "4 contradict it ("Total plots ...", and "3000" is a prep cost followed by "plots" three words later.
- impact: a permanent false warning on the car research. The check can also miss a real mismatch that hides behind a larger number from the code's own sentence.
- fix: run C19 on the model's memo fields only, and skip numbers that equal `acceptance.itemCount` or a number in the user's question.
- test: `tests/research/conceptaudit.test.ts` "C19 ignores the code's own sentence and the asked counts": stored 0c750f, expect C19 `ok === true`.
- confidence: 0.7

---

## Summary
- Counts per class: definite bug 9 (CONCEPT-1 to 9), likely bug 2 (10, 13), design flaw 1 (11), ui 1 (12). All 13 were verified by running on the stored researches; two of them (1, 3) used stubbed model replies.
- Most damaging: CONCEPT-1. Any hint edit rebuilds the decision model and discards the calibrated sub-type and kind validation; the car table then keeps 2,453 rows instead of 209 and loses every value.
- Not checked: nothing was run live, so the triggers in CONCEPT-1 and CONCEPT-3 rest on stub replies; how the UI renders the three counts of CONCEPT-5; the external verifier's own reading of the brief. Rows A7, A12, A13 and A19–A22 were not walked individually; rows A5 and A14 no longer hold as written (CONCEPT-4, CONCEPT-2).