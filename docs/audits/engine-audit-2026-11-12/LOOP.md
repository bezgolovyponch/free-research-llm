**`data/audit/LOOP.md` was not written: the `Write` tool was refused twice in this session, and I did not route around that with a shell redirect.** The full report is below; saving it needs write permission for `data/audit/`. Nothing outside `data/audit/` was changed, nothing was committed or pushed, and no network service was called.

# Engine audit 2026-11-12 · LOOP

Scope: `src/research/engine.mjs` (run, decomposition, scheduler, researchLeaf, escalation, critique/support, rollup, synthesize, stop/cancel/resume), `tree.mjs`, `treeaudit.mjs`, `prompts.mjs`, `verify.mjs`, `result.mjs`, `monitor.mjs`, `support.mjs`, `handoff.mjs`, `compact.mjs`, `dryrun.mjs`, `src/report.mjs`, plus `memocheck.mjs`, `gaps.mjs`, `attribution.mjs` and `lanes.mjs` where the loop calls them.

Method: every "verified by running" finding was run read-only with `node --input-type=module` against `data/projects/*.json` and `data/logs/*.jsonl`. The router was a stub that throws. Scratch scripts were run inline and not saved, because writes under `data/audit/scratch/` were refused too.

Researches used: b7772e (plots), 0c750f (cars), b2f5b7 (suppliers).

---

### LOOP-1. A finding made only of assumptions, with zero sources, is graded "supported"
- class: definite bug
- severity: high
- where: `src/research/attribution.mjs:36-41` (`attributionSummary`), `src/research/verify.mjs:84-90` (`checkAttribution`), `verify.mjs:41-49` (`checkNumbersSourced`)
- evidence (verified by running): `const share = factual.length ? attributed.length / factual.length : 1;` — with no factual claim the share is 1 and the check passes. `checkNumbersSourced` skips claims marked `assumption`, and `checkCitations` passes with nothing cited.
  - Real piece b2f5b7 D4.2 ("Count distinct SKUs for each target brand per supplier"), 0 sources, author `groq/openai/gpt-oss-20b`. Answer: "Assumption: Supplier A carries 120 distinct Ralph Lauren SKUs, 80 North Face SKUs, 60 Barbour SKUs; Supplier B carries 100…". All 6 claims have `assumption=true`.
  - Stored checks: `attribution:ok (0 of 0 claim(s) carry a quote found in the cited source)`, `citations:ok (0 distinct source id(s) cited)`, `numbers-sourced:ok (6 numeric claim(s) traced)`, `critique:ok (reviewer agrees)`.
  - Re-running `verifyFinding` on the stored finding gives `supported`. Same for b7772e D7.1.1.c (0 sources, "15000 EUR" entry investment, both claims assumptions). Expected: weak at most.
- impact: invented numbers count as settled pieces. D4.2 lifts driver D4 to `supported` (rolled up from `D4.1:supported, D4.2:supported`), enters coverage and the evidence probability at 0.75, and reaches the memo as a supported finding. This breaks CONCEPT's "Every finding needs sources the app fetched".
- fix: in `attributionSummary`, a finding with an answer and no factual claim does not pass (`share = factual.length ? … : 0`), with the detail "the answer rests only on assumptions". `nodeAction` already routes assumption-only pieces to Clarify.
- test: `tests/research/verify.test.ts` "assumption-only finding with no sources is weak": the stored finding of b2f5b7 D4.2 with `sources: []` must grade `weak` (today `supported`).
- confidence: 0.95

### LOOP-2. The memo check marks the table's own kept count as "contradicting the verified record"
- class: definite bug (contradiction between stages, E12)
- severity: high
- where: `src/research/memocheck.mjs:56-58` (`counted`), `:72` (`verifiedFacts.count`); `src/research/prompts.mjs:258` (`synthesizePrompt`); `src/research/engine.mjs:1271-1273`, `:1284-1286`
- evidence (verified by running): the prompt orders the model: "The table counts are final and computed by code. Use the kept count as the number of results". The checker's count pool is `finite([rows.length, v?.confirmed, t.fits, t['trade-off'], t.unverified, t.weak, t.blocked, candidates?.found, itemCount])`, and `counted` needs `r.plan?.tier === 'fits'`.
  - 0c750f has no tiers (`tiers` undefined, `keptCount` 205), so its pool is `[0, 3257, 20]`. `keptCount`, `toCheckCount` and `screenedCount` are missing.
  - Re-running `checkMemoClaims` on 0c750f: `contradicted count 205 | Total kept listings: 205 listings`, `contradicted count 80 | Required trade‑off listings: 80 listings`, `contradicted count 205 | The dataset contains 205 verified hatchback listings`.
  - The stored verdict contradicts itself in one line: "Table (computed by code): 205 results kept — the 20 asked are met … memo numbers checked against the verified record: 1 of 6 match; 3 contradict it ("Total kept listings: 205 listings"…)", with basis "0 listing(s) that fit every check".
- impact: the user reads that the memo contradicts the record when it repeats the code's own number. `recordOutcome({ purpose: 'synthesize', passed: false })` then demotes the provider that followed the prompt. B4's catch ("memo claim check") gives false alarms on every list research without a strategy.
- fix: add `candidates.keptCount`, `toCheckCount` and `screenedCount` to the `count` pool; when `candidates.tiers` is absent, take `rows` from `candidates.kept`. The asked trade-off count ("80") needs the number from the expected text or must be `unverifiable`.
- test: `tests/research/memocheck.test.ts` "kept count of a table without tiers is supported": `checkMemoClaims(report, candidates, { itemCount: 20 })` with 0c750f's stored report and candidates returns no contradicted claim with value 205.
- confidence: 0.95

### LOOP-3. A parent is not rolled up again when a child is re-researched after a failure or a drift downgrade
- class: definite bug
- severity: medium
- where: `src/research/engine.mjs:1513` (run), `:1548` (`if (DONE.has(node.status)) return;`), `src/research/monitor.mjs:243-244` (`regradeSettled`); contrast `engine.mjs:1688` (`regrade` resets every ancestor)
- evidence (verified by running): `for (const node of project.nodes) if (node.status === 'failed' || node.status === 'researching') node.status = 'pending';` and `node.status = downgradeTo;` change only the leaf. The parent keeps a DONE grade, because `finished()` counted the failed child and it was rolled up as `unsupported`. The scheduler then skips DONE nodes.
  - On a copy of b2f5b7 with D4.1's drift counter at its 2026-11-06 value: before `D4:supported D4.1:supported`. After `regradeSettled`: `D4:supported rolledUpFrom=["D4.1:supported","D4.2:supported"]`, `D4.1:pending`. Run queue: `["D4.1"]` only.
  - In the stored data b2f5b7 D5 records `["D5.1:weak","D5.2:supported"]` while D5.2 is now `weak`.
- impact: after "Press Run to resume; finished nodes are kept", a driver still shows the grade and answer computed from the failed or old child. The memo, coverage, action plan and evidence probability read that stale driver.
- fix: in both places call the ancestor reset that `regrade` uses (every ancestor set to pending, with finding, verification and critique cleared).
- test: `tests/research/engine.test.ts` "a resumed failed leaf re-rolls its parent": tree D4/D4.1/D4.2 from b2f5b7 with D4.1 `failed` and D4 `unsupported`; after `run`, D4's `rolledUpFrom` names D4.1's new grade.
- confidence: 0.9

### LOOP-4. The last attempt overwrites a better earlier attempt
- class: design flaw
- severity: medium
- where: `src/research/engine.mjs:1190` (`researchLeaf`)
- evidence (verified by running): `Object.assign(node, { finding, critique, verification, attempts: attempt, … status: verification.grade });` runs on every attempt, and nothing keeps the best one.
  - Log scan of all three `project-*.jsonl` files for "(attempt N, … tier, …)": 1,193 research passes reached attempt 3. In 138 of them (11.6%) the final grade is below an earlier attempt of the same pass.
  - Examples: `0c750f D5.2 weak -> unsupported -> unsupported (2026-11-03T12:30:36.617Z)`, `b7772e D8.2.1.1.b weak -> weak -> unsupported (2026-10-27T08:41:14.185Z)`, `b7772e D7.1.1.c weak -> weak -> unsupported (2026-10-27T08:46:38.814Z)`.
- impact: one in nine escalated pieces ends worse than what the run already held. A weak answer with usable claims is replaced by an unsupported one, which lowers the parent and the result.
- fix: keep the best attempt by grade rank, then score, and assign it to the node after the loop.
- test: `tests/research/engine.test.ts` "escalation keeps the best attempt": a router stub whose three replies grade weak, weak, unsupported leaves the node `weak` with attempt 1's finding.
- confidence: 0.85

### LOOP-5. All three list researches are typed "estimate" or "plan", so the memo gets the wrong rule
- class: definite bug
- severity: medium
- where: `src/research/result.mjs:49-58` (`KINDS`, `questionKind`); used at `engine.mjs:1246`, `:1253`; `prompts.mjs` `KIND_RULE`
- evidence (verified by running): the first matching pattern wins, and `plan` and `estimate` come before `list`. `questionKind` on the stored projects:

  | Research | Words that match | itemCount | Kind |
  |---|---|---|---|
  | 0c750f | "Find accurate and verified car listings … highest price/value ratio" | 20 | `estimate` |
  | b7772e | "Find appropriate plots … strong price increase trend" | 50 | `plan` |
  | b2f5b7 | "Find the wholesale … providers … highest price/value ratio" | 20 | `estimate` |

  Stored `report.kind` matches. The memo model is told "This question asks for a NUMBER … The verdict states the number with its unit" or "asks for a PLAN … names the top action". It is never told "asks for a LIST. The verdict says how many items were found and verified".
- impact: the model memo of 0c750f is "GO". `resultModel` builds an action ranking or a best estimate for a research whose result is a table.
- fix: `if (project.acceptance?.itemCount) return 'list';` before the patterns.
- test: `tests/research/result.test.ts` "a question with an item count is a list": the three stored questions with their `acceptance.itemCount` return `list`.
- confidence: 0.9

### LOOP-6. An outage during the meaning check is stored as a finished check: verified pieces drop to supported and are never rechecked
- class: definite bug
- severity: medium
- where: `src/research/support.mjs:83-86` (`supportVerdict`), `:107-111` (`supportRecord`), `:130-132` (`isStale`); `src/research/engine.mjs:1110-1116` (`supportVote` swallows every error), `:1706-1722` (`recheckSupport`)
- evidence (verified by running): `if (cast.length < 2) return 'unchecked';` and the record always carries `version: SUPPORT_LOGIC_VERSION`. `isStale` is `claim?.support?.version !== SUPPORT_LOGIC_VERSION`.
  - `recheckSupport` on a copy of b7772e, with a router that throws the router's own message "all free model quotas are cooling down after rate limits; retry in a minute".
  - Before: `D1.1.1.2:verified D8.2.1.2:verified D7.1.1.bx:verified D8.2.1.1.b.3:verified`. Result: "rechecked 6 piece(s), 13 claim(s): 13 to confirm". After: all four `supported`.
  - Record written: `{"version":2,"verdict":"unchecked","votes":[],"cause":"• Meaning not checked yet (no free model answered)"}`.
  - Second recheck: "rechecked 0 piece(s), 0 claim(s)", 0 router calls.
  - The same record is written in `researchLeaf` when both votes fail.
- impact: pressing Recheck while providers rest downgrades every verified piece it touches. No later Recheck repairs it; only a full re-research does.
- fix: `isStale` also returns true for `verdict === 'unchecked'`; `recheckSupport` keeps the previous record when no vote was cast.
- test: `tests/research/support.test.ts` "an unchecked claim stays due for a recheck": `isStale` is true for a claim whose support is `supportRecord({ votes: [] })`.
- confidence: 0.9

### LOOP-7. The second meaning vote can come from the author's own provider (B5)
- class: definite bug
- severity: medium
- where: `src/research/engine.mjs:1122-1124` (`voteOnQuote`)
- evidence (by reading, plus stored data): `const second = await this.supportVote('support-second', 'fast', first?.provider ?? author, claim.text, shown);` — once the first vote exists, the second avoids only the first voter. `router.available` takes one `avoid` id, so the author is fully eligible.
  - Stored b2f5b7 D3.2: author `gemini/gemini-3.1-flash-lite`. Votes: `pollinations/openai-fast: yes` and `gemini/gemini-3.5-flash-lite: yes`. Verdict `supported` ("two models agree").
- impact: Part 4 row B5 ("reviewer and meaning votes avoid the author's provider") does not hold for the second vote. A claim can be confirmed by its author's provider and a sibling model of the same family.
- fix: let `avoid` accept a list and pass `[author, first?.provider]` for the second vote.
- test: `tests/research/engine.test.ts` "the second meaning vote avoids the author": a router stub records `avoid`; with author `gemini` and first voter `pollinations`, the second call's `avoid` includes `gemini`.
- confidence: 0.85

### LOOP-8. The drift monitor re-researches freshly settled pieces against a baseline that never moves; champion/challenger never runs
- class: design flaw
- severity: medium
- where: `src/research/monitor.mjs:126-132` (`captureBaseline`), `:160-166` (`driftCheck`), `:234-246` (`regradeSettled`); `src/research/engine.mjs:1214` (`if (!node.drift?.baseline) captureBaseline(node);`), `:1155-1156`, `:1694-1700`
- evidence (verified by running): the baseline is captured once and never replaced. With one number per finding the score is always above the limit: `driftScore([4],[1])` = 0.84, `driftScore([4],[5])` = 0.68, limit 0.40.
  - Stored b2f5b7 D4.1: baseline `[4]` of 2026-11-05T02:10Z. Samples: `[1]` 0.84 (2026-11-06T13:45Z), `[0]` 0.92 (2026-11-11T16:11Z), `[0]` 0.92 (2026-11-12T12:12Z). `driftResearches` is 2.
  - So a piece that was re-researched and settled with a new number is set back to pending at the next run start, twice, and stays "drifted" for good.
  - The 0c750f log has "drift detected, re-researching: D2.1 (0.7)" 12 times between 2026-11-03T14:20Z and 16:12Z, more than `MAX_DRIFT_RESEARCHES` = 2 allows. The cause is not confirmed; loop trial copies restoring the counter is the likely one.
  - Champion/challenger: `settledBefore = SETTLED.has(node.status)` is false whenever `run` calls `researchLeaf`, because settled nodes are skipped at `:1548` and `resetWithAncestors` clears the finding first. "previous finding kept" occurs 0 times in the 37,049 log lines.
- impact: free quota is spent re-researching pieces that just passed. A re-research that turns a verified piece weak replaces it, although the code that should keep the better finding exists.
- fix: move the baseline to the accepted sample after a drift re-research; require at least 3 values before scoring; make `resetWithAncestors` keep the previous finding as `node.champion` and read that in `researchLeaf`.
- test: `tests/research/monitor.test.ts` "a re-researched piece is not drifted against its old baseline": D4.1's stored drift after a third sample `[0]` gives no change from `regradeSettled`.
- confidence: 0.8

### LOOP-9. The stop flag is never cleared, is accepted on an idle research, and is only read between stages
- class: definite bug
- severity: medium
- where: `src/research/engine.mjs:1470-1477` (`stopIfCancelled`), `:1482` (only `run` clears it), `:1658-1660` (`cancel`), `:1150-1152`, `:491`; `src/server.mjs:340-343`
- evidence (verified by running): `cancel(id) { this.cancelled.add(id); }`, and the route calls it without checking `running`.
  - On a copy of b7772e: `engine.cancel(id)` with `running` false leaves `cancelled` true. `recheckSupport(id)` then throws `ResearchCancelled` with an empty message and 0 router calls. The server maps that class to no known status.
  - The flag also stays set after every stopped run, because `stopIfCancelled` does not delete it.
  - By reading: with the flag set, the background table rebuild (`applyWarmed` → `collectCandidates` → `measureDistances`, `:491`) skips all geocoding and marks the rows `unmeasured`.
  - Row D7 holds only partly. There is no check during decomposition or concept validation, and none during the memo. Inside the listings stage `sweep.mjs` has no cancel check; the one check at `:1531` comes after the sweep, the knowledge search, up to 400 fact pages and a second table build.
- impact: after any Stop, "Recheck claims" fails with an empty error until the next Run. A Stop pressed during the portal sweep is honoured only when the whole stage ends.
- fix: delete the flag in `stopIfCancelled` and in `run`'s `finally`; ignore `cancel` when the research is neither running nor looping; pass `shouldStop` into the sweeper.
- test: `tests/research/engine.test.ts` "a stop on an idle research does not block the next action": `cancel(id)` then `recheckSupport(id)` resolves.
- confidence: 0.9

### LOOP-10. A rollup is one fast call with no retry; one failed self-check puts a driver below its settled children
- class: design flaw
- severity: medium
- where: `src/research/engine.mjs:1220-1235` (`rollup`)
- evidence (stored data): `const grade = ownChecksPassed ? fromChildren : GRADE_RANK[fromChildren] < GRADE_RANK[verification.grade] ? fromChildren : verification.grade;` after a single `tier: 'fast'` call.
  - b7772e D8.2.1.1.b: children `supported, verified, verified`, driver `weak`, attempts 1. Failed check: "attribution: 1 of 3 claim(s) carry a quote found in the cited source".
  - b7772e D1.1.1: children `supported, verified`, driver `weak`. Failed check `concrete` on the answer "There is no available evidence indicating that any coastal land parcels in Spain are listed for sale at 20,000 EUR or less…", which is a negative result, not a missing one.
  - Both then make D8.2.1.1, D8.2.1, D8.2, D8, D6 and D1.1, D1 weak.
- impact: two top-level drivers of b7772e are weak because one summary call misquoted its children. The action plan sends the user to "Re-research" pieces whose evidence is settled.
- fix: on a failed self-check retry once on the deep tier with the failures as feedback; if it still fails, compose the driver answer from the children's answers by code.
- test: `tests/research/engine.test.ts` "a rollup that misquotes is retried": the router stub returns D8.2.1.1.b's stored finding first and a correctly quoted one second; the driver grade is `supported`.
- confidence: 0.75

### LOOP-11. "Not an answer" is matched anywhere in the answer, so a concrete answer with an honest caveat fails
- class: likely bug
- severity: medium
- where: `src/research/verify.mjs:52` (`NON_ANSWER`), `:72` (`checkConcrete`)
- evidence (verified by running): `if (NON_ANSWER.test(answer) || isEvidenceGap(answer))` tests the whole answer, while `isEvidenceGap` reads the first sentence only.
  - b2f5b7 D5: "Suppliers can partially fulfill B2B orders and ship to Prague efficiently, with delivery times ranging within 2 to 4 working days, though currency and invoicing acceptance for bulk orders remains unknown due to a lack of data."
  - Re-verified: `weak`, failed `concrete (answer says the evidence cannot settle it)`. The same finding without the last five words ("due to a lack of data"): `supported`, no failed check.
  - b2f5b7 D6.2 ("we can list 14 direct supplier page URLs…; the remaining 6 … are not present in the evidence") fails the same way.
  - The alternation also starts with a bare `no` with no word boundary.
- impact: models that state their limits are graded below models that leave them out. The gate rewards dropping caveats.
- fix: test `NON_ANSWER` on `firstSentence(answer)` and add `\b` before the first alternative.
- test: `tests/research/verify.test.ts` "a caveat after a concrete answer does not fail concrete": D5's stored finding grades `supported`.
- confidence: 0.8

### LOOP-12. The exported report prints the model's own confidence next to the code's verdict
- class: ui
- severity: low
- where: `src/report.mjs:101` (`toMarkdown`); `src/research/engine.mjs:1254`
- evidence (verified by running): the line is `**${r.verdict}** (confidence: ${r.confidence})`, where `r.confidence` is the model's field.
  - `toMarkdown` on b7772e prints "**PROVISIONAL (low confidence; 16 pieces to fix, research or clarify) — … ** (confidence: high)", followed by "Evidence quality: 14/30 nodes verified or supported".
  - `resultsJson` shows both: `{"model":"high","byChecks":"low","coverage":0.47}`.
- impact: the .md export states two opposite confidences on one line, and the one in brackets is a model grading itself.
- fix: print `r.status?.confidence` there; show the model's value only as "model's own: high".
- test: `tests/report.test.ts` "the verdict line carries the confidence from the checks": b7772e's markdown does not contain "(confidence: high)".
- confidence: 0.9

### LOOP-13. A failed or pending piece scores higher than a weak or unsupported one in the evidence probability
- class: definite bug
- severity: low
- where: `src/research/result.mjs:6` (`GRADE_PROBABILITY`), `:39-41` (`nodeProbabilities`)
- evidence (verified by running): `GRADE_PROBABILITY` has no `failed` or `pending`, and a leaf takes `own ?? NO_INFO` = 0.5. That is above weak (0.4) and unsupported (0.15).

  | b2f5b7 variant | Overall | D6 |
  |---|---|---|
  | As stored (D6.2 `unsupported`) | 0.52 | 0.24 |
  | D6.2 `failed` (what `run` sets on an error) | 0.58 | 0.42 |
  | D6.1 and D6.2 `failed` | 0.59 | 0.46 |

- impact: a run that errors on its weakest pieces shows a higher "overall evidence probability" than one that researched them.
- fix: add `failed: 0.15`; leave pending leaves out of the aggregate.
- test: `tests/research/result.test.ts` "a failed piece never raises the probability": b2f5b7 with D6.2 failed gives a probability ≤ 0.52.
- confidence: 0.85

### LOOP-14. Pieces "covered by code" are listed as "Research further" and count as not researched
- class: definite bug (contradiction between stages)
- severity: low
- where: `src/research/gaps.mjs:3`, `:19`, `:42-45` (`nodeAction`), `:68-72` (`resultStatus`); `src/research/tree.mjs:181-182` (`progress`); `src/research/treeaudit.mjs:109`
- evidence (verified by running): `markListingWork` sets `n.status = 'covered'`, and the engine logs "pieces covered by code on the candidate table, not researched". `SETTLED` in `gaps.mjs` and the lists in `progress` do not contain `covered`.
  - A copy of b2f5b7 D3.1 with the fields `markListingWork` sets returns `{"action":"research","why":"graded covered","next":"Open D3.1 → Instructions & pages to read, paste the exact pages … then ↻ Re-research"}`.
  - `progress` gives `finished 0, verified 0`. `resultStatus` gives `provisional true, coverage 0, confidence low`.
  - The stored projects hold no covered piece now, so this ran on a constructed status.
- impact: a list research with covered pieces can never leave PROVISIONAL or reach high confidence, and the plan tells the user to re-research what the tree stage decided not to research.
- fix: treat `covered` as settled in `gaps.mjs` and as finished in `progress`.
- test: `tests/research/gaps.test.ts` "a covered piece needs no action": `nodeAction({ status: 'covered', coveredBy: 'candidate-table' })` is null.
- confidence: 0.8

### LOOP-15. The headline says 273 results fit; 266 fit and are confirmed (row A1)
- class: definite bug
- severity: low
- where: `src/research/candidates.mjs:335`, `:340` (`tableVerdict`); compare `src/research/memocheck.mjs:56-58` (`counted`)
- evidence (verified by running): `const fits = t.fits ?? 0;` is printed as "`${fits}` results of the 50 asked fit every check (… a result counts only when it fits every check and is confirmed)".
  - Stored b7772e: `tiers.fits` is 273. Of the 273 kept rows with tier `fits`, 266 have verdict `confirmed` and 7 `unconfirmed`.
  - The verdict starts "273 results of the 50 asked fit every check", while the claim check in the same verdict uses "266 listing(s) that fit every check and were confirmed by the external verifier".
- impact: the first number the user reads is 7 above the count the same sentence defines. A1's catch does not reach the memo verdict.
- fix: print the confirmed fits first ("266 results fit every check and are confirmed; 7 fit and wait for confirmation").
- test: `tests/research/candidates.test.ts` "the verdict headline counts fits that are confirmed": `tableVerdict` on b7772e's stored candidates starts with 266.
- confidence: 0.85

---

Counts: 10 definite bug, 1 likely bug, 3 design flaw, 1 ui, 0 uncertainty (15 findings).
Most damaging: LOOP-1 — an answer made only of assumptions with no source grades "supported" (b2f5b7 D4.2, b7772e D7.1.1.c) and feeds drivers, coverage and the memo.
Not checked: a live run (no network, router stubbed); `handoff.mjs` and the restart path of D8 beyond reading `app.mjs:424-428`; why the 0c750f log shows 12 drift re-researches of one piece; whether b7772e's 30 stored pieces are a trimmed snapshot or lost pieces (its rollups name 22 children no longer in the tree); `applyWarmed` calling `checkAcceptance` with `project.report` null during a first run (`engine.mjs:1031`, `:1454`, by reading only); `nodeIdsIn` reading `D7.1.1.bx` as `D7.1.1` (seen by running, not ranked).