**`data/audit/LEARNING.md` was not written: the `Write` tool was refused for that path (and for `data/audit/scratch/`), and I did not route around that with a shell redirect.** The full report is below; saving it needs write permission for `data/audit/`. Nothing was changed, committed or pushed, and no network service was called.

# Engine audit 2026-11-12 · LEARNING

Scope: `src/research/improve.mjs`, `playbook.mjs`, `trialmerge.mjs`, `lessons.mjs`, `src/llm/router.mjs`, `ranking.mjs`, `outcomes.mjs`, `admin.mjs`, `provider.mjs`, `presets.mjs`, `src/app.mjs`, `src/watchdog.mjs`, `src/heapguard.mjs`, `verifier/verify.mjs` (+ `coast.mjs`, `claims.mjs`), and the glue the loop and verifier call in `engine.mjs` and `verification.mjs`.

Method: every "verified by running" finding was run read-only with `node --input-type=module` against `data/projects/*.json`, `data/logs/*.jsonl` and `data/verification/*.jsonl`, with stub engines, stores and providers. Scratch scripts were run inline and not saved.

Researches used: b7772e (plots), 0c750f (cars), b2f5b7 (suppliers).

---

### LEARNING-1. The second measurement re-reads cached pages, so the measured noise is always 0 (row D2 is back)
- class: definite bug
- severity: high
- where: `src/research/engine.mjs:1426-1430` (`remeasure`), `src/research/improve.mjs:740-746` (`commit`), `:64-73` (`noiseFloor`, `noiseBar`)
- evidence (by reading, plus stored data): `remeasure` is `if (project.report) await this.checkAcceptance(project, pages);` with the loop's own `state.pages` cache. It researches nothing, so the same pages give the same score. The reject text says so: `` `measured ${score.score}, re-measured ${again.score} from the cached pages` ``. In a scoped loop `measure` is `scopeScore` (grades and checks only), which `remeasure` cannot change at all.
  - b2f5b7 `improve.remeasureNoise`: 30 samples, all `0`. `noiseFloor` is then 0.001.
  - 0c750f was measured by the older code ("re-measured 0.71 after researching the same pieces again"): samples `[0, 0.006, -0.036, -0.045]`, and both of its later candidates were reverted (0.746 → 0.71, 0.755 → 0.71).
  - b2f5b7 kept 8 changes with gains of 0.003 to 0.023 (for example Q 0.642 → 0.645), all below the 0.036–0.045 swing measured on 0c750f.
  - The change came with commit 321e4be ("page reads cached per loop"). CONCEPT still says "The second measurement researches the changed pieces again, so the noise is real".
- impact: "kept only if the score rises on two measurements by more than the measured noise" is one measurement against a noise of zero. One lucky run raises the bar, which is the failure the rule exists to stop. The page cache also lives for the whole loop (up to 72 h), so "working links" are judged on pages read hours earlier.
- fix: in `remeasure`, research the trial's changed pieces again on a copy (as before 321e4be) and read the acceptance pages without the loop cache; for a scoped loop, re-research the touched pieces before `scopeScore`.
- test: `tests/research/improve.test.ts` "the re-measure researches the changed piece again": a stub engine counts `researchLeaf` calls during `commit` on b2f5b7's D2.1; the count after a candidate gain must be 2, and a router stub that answers differently the second time must give a non-zero `remeasureNoise` sample.
- confidence: 0.9

### LEARNING-2. One bad verifier run replaced every confirmation: 353 → 47 confirmed in two minutes, result 100% → 38% for 47 minutes
- class: design flaw
- severity: high
- where: `verifier/verify.mjs:424-435` (`verify` checks every row on every run), `:349-358` (`listing online` unconfirmed on any fetch failure); `src/research/engine.mjs:993-1015` (`startVerification`); `src/research/verification.mjs:26-38`
- evidence (stored data): the verifier starts whenever one row is pending, then re-fetches all rows and overwrites the whole record.
  - `data/verification/…b7772e.jsonl`: 69 runs, 61 distinct `inputs`, each over 863–921 rows. The log shows "external verifier started on 1 plot(s)" five times on 2026-11-02 alone; the records written after those starts each cover 905–919 rows.
  - `2026-11-03T05:20:45Z confirmed 353 of 921`, then `05:22:38Z confirmed 47 of 921`, then `06:12:49Z confirmed 369 of 921`. The second run started in the same second the first ended (05:22:16Z, "started on 3 plot(s)").
  - Project log: `05:22:16Z expected result: 100%`, `05:33:00Z expected result: 38% — At least 50 valid items 38%`, still 38% at 06:09:11Z, `06:20:32Z expected result: 100%`. The record before and the record after confirm 353 and 369 of the same 921 rows.
- impact: the headline result and the loop's baseline fall and recover with the portals' rate limits, not with the evidence. About 60,000 listing fetches went to three portals for 69 runs, which is what makes them answer badly. A user who opened Results between 05:33Z and 06:20Z saw 19 of 50 plots.
- fix: verify only rows that are pending or whose own inputs (`url, price, currency, area, lat, lon` plus obligations) changed, and merge them into the stored record. When a row's new verdict is `unconfirmed` only because the page could not be read (429, 5xx, timeout), keep its previous `confirmed` verdict for 24 h and mark it "to re-check". Pace fetches per host.
- test: `tests/verifier.test.ts` "a run that cannot read the pages keeps earlier confirmations": a record with b7772e's 266 confirmed fits, then a run whose `fetchImpl` answers HTTP 429 for every listing; the merged record still confirms 266.
- confidence: 0.85

### LEARNING-3. A half-written or unreadable verifier record is read as "nothing confirmed"; `complete` and `inputs` are never checked (row C-2)
- class: definite bug
- severity: medium
- where: `src/research/verification.mjs:17-24` (`readVerification`), `:28-33` (`applyVerification`); `verifier/verify.mjs:429` (`complete`), `:452-454` (`save` after every row); `src/research/engine.mjs:875`, `:996-998`
- evidence (verified by running): the verifier rewrites `<id>.json` after each row with `complete: false`. The app reads it on every table rebuild and takes `{ verdict: 'pending' }` for each row not in it. No file in `src/` reads `record.complete` or `record.inputs` (grep: 0 matches).
  - `applyVerification` on b7772e's stored table, with a record rebuilt from the rows' stored verdicts:

    | Record given | `keptCount` | `pending` |
    |---|---|---|
    | Full record | 266 | 0 |
    | First 100 results only (a run in progress) | 96 | 782 |
    | `null` (file caught mid-write, `JSON.parse` fails) | 0 | 882 |

  - Results are matched by URL alone (`byUrl.get(row.url)`). A row whose price, area or map point changed, or a research whose e-bike distance or price limit the user edited, keeps its old "confirmed", because `startVerification` returns when `verification.pending` is 0 and the signature is the URL list.
  - A verifier that exits with an error leaves `verifying.get(id).signature` set, so it is not started again until the URL set changes or the app restarts.
- impact: during each re-run the count of results drops toward 0 and climbs back. A confirmation can outlive the facts it confirmed. Part 4 row C-2 names "inputs hash in the record" as the catch; nothing compares it.
- fix: the verifier writes to `<id>.json.tmp` and renames when `complete`; `readVerification` ignores a record that is not complete; `applyVerification` treats a row as pending when its own input tuple or the obligations differ from those in the record; clear the signature when the run fails.
- test: `tests/research/verification.test.ts` "an incomplete record does not replace the last complete one": b7772e's table with the first 100 results and `complete: false` keeps `keptCount` 266.
- confidence: 0.9

### LEARNING-4. A provider that times out is treated as "offline": one call retries 22 times over 108 minutes and the slow-provider bench is undone
- class: definite bug
- severity: high
- where: `src/llm/router.mjs:13` (`NETWORK_ERROR = /unreachable|fetch failed|…/`), `:563-571` (`complete`), `:455-464` (`restoreProviderState`); `src/llm/provider.mjs:157-158` (`` `${this.id} unreachable: ${reason}` ``, reason `timed out`)
- evidence (verified by running): every provider timeout message contains "unreachable", so `errors.every(isNetworkError)` is true when the only open providers are slow. The router then restores the state from before the attempt, which deletes the timeout streak and the 10-minute bench, waits 15–60 s and calls the same provider again, for up to 20 minutes of waiting.
  - One `router.complete({ tier: 'deep', purpose: 'research' })` with a single ready provider that fails as `fcc unreachable: timed out` after its 240 s preset timeout: 22 calls to the provider, 1,185 s of sleeps, 108 minutes for the one call, then `OfflineError`. Afterwards `cooldownUntil.get('fcc')` is unset and the timeout streak is unset.
  - The ledger has this error for real: `gemini unreachable: timed out` 15, `nvidia` 12, `cohere` 10, `llamacpp` 5. Part 4 row D9 records fcc timing out on 20 calls in a row (14:14–18:01Z on 2026-11-03).
- impact: when the fast providers rest after rate limits and a slow proxy or local model is the only one open, each research call hangs for over an hour instead of failing in minutes. The run is marked `paused` ("the network was down") although the network is fine. "Two timeouts in a row bench a provider for 10 min" (PROTOCOLS 4h) never takes effect in this state.
- fix: do not count `unreachable: timed out` as a network error (`isNetworkError` returns false when `TIMED_OUT` matches); keep the offline path for `fetch failed`, `ENOTFOUND`, `ECONNREFUSED`, `EAI_AGAIN`.
- test: `tests/llm/router.test.ts` "a provider that times out is benched, not waited for": one provider throwing `fcc unreachable: timed out`; `complete` rejects with `NoModelAvailableError` after at most 2 calls and `cooldownUntil.get('fcc')` is set.
- confidence: 0.9

### LEARNING-5. The first four real gains of every research are thrown away, then refused as repeats; the plateau rule ends the loop before a fifth can come
- class: design flaw
- severity: medium
- where: `src/research/improve.mjs:76` (`trialVerdict`), `:743-746` (`commit`), `:146` (`FUTILE` holds `reverted-noise`), `:224-226` (`repeatOf`), `:209-220` (`plateauCheck`); `src/research/playbook.mjs:11`, `src/research/lessons.mjs:8` (`TESTED` holds `reverted-noise`)
- evidence (verified by running): `if (samples.length < NOISE_MIN_SAMPLES) return { ok: false, reason: NOISE_UNMEASURED };` with 5 samples needed, and a sample is added only when a trial already beat the best score.
  - `trialVerdict(best, best + 0.2, [], samples)` on the stored samples of 0c750f (`[0, 0.006, -0.036, -0.045]`) and b7772e (`[-0.002, -0.005, -0.005, -0.005]`): `{"ok":false,"reason":"noise not yet measured"}`. A gain of 0.2 is refused on both.
  - 0c750f produced candidate gains at trials 1, 2, 25 and 37 of 45 in 10 hours. Replaying its trials with those gains refused, `plateauCheck` stops the loop after trial 14 (2026-11-03T14:58Z), 46 minutes after the first stored trial.
  - The refused change is stored as `reverted-noise`. `repeatOf` then finds it (run: `true`), so the same change is refused as "same change as the reverted-noise trial" for as long as it stays in the last 200 trials. It also counts as "harmful" in the ledger and as "does not help" in the cross-research lessons.
- impact: a new research cannot keep anything in its first loop. Its best early changes are marked as failures and blocked, and the user reads "plateau: 12 trials in a row without a gain above the noise floor".
- fix: measure the noise at loop start by re-measuring the unchanged baseline 5 times (no trial needed); record an unmeasured revert as `noise-unmeasured`, outside `FUTILE` and `TESTED`.
- test: `tests/research/improve.test.ts` "a gain refused only because noise is unmeasured can be proposed again": `repeatOf` on 0c750f's kept trial of 2026-11-03T14:12Z, re-labelled as the new outcome, returns null.
- confidence: 0.85

### LEARNING-6. The ledger refuses changes as "never kept" that were kept minutes earlier on the same piece type
- class: definite bug
- severity: medium
- where: `src/research/playbook.mjs:49-62` (`ledger`), `:64-66` (`refusedByLedger`)
- evidence (verified by running): each trial joins the first bullet it resembles (`bullets.find((b) => similarChange(b.change, t.change) >= LEDGER_SIMILARITY)`), and `helpful` counts only keeps that landed in that bullet. A kept change that joined another bullet leaves this one at `helpful === 0`.
  - b2f5b7: 57 of the stored 200 trials are `repeat` with "like a change tested N times … and never kept". For 10 of them, a change kept earlier on a piece of the same type is at least 0.5 similar.
  - Example, similarity 0.78:
    - Refused 09:27:56Z on D1.2.1: "Replace the abstract lookup with direct reads of the public per-brand catalog and 'brands we stock' pages on a source type not yet used for this piece — the B2B second-hand wholesale marketplaces' own brand-filtered category URLs (Faire, An…".
    - Kept 09:05:58Z on D2.2 (0.597 → 0.619): "Replace the Google-search lookups with direct reads of the public per-brand and 'brands we stock' catalog pages on a source type not yet used for this piece — the B2B wholesale marketplaces' own brand-filtered category URLs (e.g. Faire, Ank…".
  - Refused changes on different pieces also name different sources (trade-association directories on D3.1.2, marketplace assortment pages on D4.1; pairwise similarity 0.19–0.36), so the match is on the model's stock phrasing.
- impact: over a quarter of the loop's proposals in b2f5b7 were refused without a test, including the one kind of change that was raising the score. Each refusal still costs a deep-tier model call and counts toward the piece's rest and the plateau (LEARNING-9).
- fix: in `refusedByLedger`, refuse only when no kept trial of the type is `>= LEDGER_SIMILARITY` similar to the proposed change (compare against trials, not the bullet's own count).
- test: `tests/research/playbook.test.ts` "a change like a kept one is not refused": `refusedByLedger` over b2f5b7's trials before 09:27:56Z for the D1.2.1 change returns null.
- confidence: 0.85

### LEARNING-7. A loop the user stopped is resumed after a restart (row D8 does not hold for loops)
- class: definite bug
- severity: medium
- where: `src/research/improve.mjs:367-374` (`shutdown`), `:410`; `src/app.mjs:449-455` (`resumeInterrupted`)
- evidence (verified by running): `shutdown` writes `saveHandoff(id, 'app stopped', { loopHoursLeft: … })` for every entry in `active` and sets `state.shutdown`, without looking at `state.stopped`. A stopped loop stays in `active` until its current model call or piece ends (up to 240 s per call).
  - Stub engine on b2f5b7: `start(id, { hours: 8 })` → `stop(id)` returns `{"ok":true}` → `shutdown()` writes `{"reason":"app stopped","resume":{"loopHoursLeft":7.99…,"loopScope":[],"loopExclude":[]}}`.
  - When the loop then ends, no "loop stopped by user" handoff replaces it, because `if (!state.shutdown)` skips it.
  - `resumeInterrupted` starts the loop for any record with `loopHoursLeft > 0.05`.
- impact: after Stop, then an update or restart within a few minutes, the loop runs again for its remaining hours on free quota, and on the paid fallback once the free providers rest.
- fix: in `shutdown`, when `state.stopped` was already true, write the handoff with reason "loop stopped by user" and an empty resume.
- test: `tests/research/improve.test.ts` "a stopped loop is not resumed after shutdown": start, stop, shutdown; the last handoff has no `loopHoursLeft`.
- confidence: 0.9

### LEARNING-8. The watchdog never revives a crashed loop when the loop before it was stopped by the user; a running loop shows "stopped by user"
- class: definite bug
- severity: medium
- where: `src/watchdog.mjs:7` (`crashedLoop`), `src/research/improve.mjs:517` (start record), `:406` (crash record), `src/store.mjs:57`
- evidence (verified by running): the start record is `{ active: true, startedAt, deadline, hours, scope, exclude, error: null }`. It does not clear `stopReason` or `finishedAt`, and the crash record is `{ active: false, error }`. `crashedLoop` returns null when `improve.stopReason === 'stopped by user'`.
  - Stored 0c750f: `active true`, `startedAt 2026-11-04T00:17:26Z`, `finishedAt 2026-11-04T00:12:50Z`, `stopReason "stopped by user"`. The end time is before the start, and the stop reason belongs to the previous loop.
  - `crashedLoop` on that state with `active: false`, an error and 1 h left: `null`. The same state without the stale `stopReason`: `{"hoursLeft":1,…}`. b7772e gives the same pair; b2f5b7 (previous loop ended on time) is revived.
  - The stored 0c750f still says `active: true` with a deadline of 2026-11-04T11:14Z, so the list and the C8 check read it as running until the next loop.
- impact: after the user has stopped a loop once, every later loop on that research loses the watchdog restart. The stored state says a running loop was stopped by the user.
- fix: add `finishedAt: null, stopReason: null` to the start record; in `settleStale`, set `improve.active = false` for researches with no live loop.
- test: `tests/watchdog.test.ts` "a crash after an earlier user stop is revived": `crashedLoop` on 0c750f's stored `improve` after a new start record and a crash record returns the hours left.
- confidence: 0.9

### LEARNING-9. Proposals that were never tested count as futile trials: pieces rest for 6 h and the loop "plateaus" on refusals
- class: likely bug
- severity: medium
- where: `src/research/improve.mjs:146` (`FUTILE` holds `repeat`, `no-change`, `reverted-structure`), `:159-168` (`restEnds`), `:207-220` (`NOT_A_MEASURED_TRIAL`, `plateauCheck`), `:203-205` (`plateauStopReason`)
- evidence (verified by running): `plateauCheck` skips only `provider-outage`, `error`, `reverted-stopped` and `conflict`; `restEnds` counts everything in `FUTILE`.
  - b2f5b7 holds 92 `repeat`, 37 `reverted-structure` and 6 `no-change` in 200 trials. None of these researched anything.
  - `plateauCheck` over the stored trials fires at trial 12 (2026-11-04T08:14:26Z). The 12 it counted: 6 `repeat`, 1 `reverted-structure`, 1 `no-gain`, 4 `reverted-whole`. The stored loop went on to keep 8 changes after that point (best 0.577 → 0.665).
  - First three-in-a-row streaks that would put a piece to rest: D4.1 `repeat, repeat, no-gain`; D4.2.1 `repeat, repeat, reverted-structure`; D5 `reverted-structure` × 3.
  - The streak is never cleared when the rest ends. D4.1 re-dated: not resting 6 h 1 min after its last trial; one more futile trial and it rests for another 6 h.
- impact: the loop stops with "12 trials in a row without a gain above the noise floor" when half were never measured, and a piece gets one try per 6 hours after its first rest. With LEARNING-6 the refusals are often wrong to begin with.
- fix: add `repeat`, `no-change` and `reverted-structure` to `NOT_A_MEASURED_TRIAL` and keep them out of the rest streak (cap them separately, for example 5 refusals in a row skip the piece for the pass); reset a piece's streak when its rest ends.
- test: `tests/research/improve.test.ts` "refused proposals do not make a plateau": `plateauCheck` on the first 12 stored trials of b2f5b7 returns `plateaued: false`.
- confidence: 0.75

### LEARNING-10. The verifier confirms a plot on the app's own map point, and "price on the page" is any number on the page near the app's price
- class: design flaw
- severity: medium
- where: `verifier/verify.mjs:368-372`, `:398` (`verifyRow`), `:232-238` (`compare`), `:360-361`; `src/research/verification.mjs:32`
- evidence (by reading): `const point = own ?? (Number.isFinite(row.lat) && Number.isFinite(row.lon) ? { lat: row.lat, lon: row.lon } : null);` and then `checks.filter((c) => c.status === 'unconfirmed' && c.check !== 'location source')`.
  - When the listing page shows no coordinates, the country, sea distance and camping months are computed from the point the app geocoded. The check "location source: unconfirmed (the app's point was used)" is left out of the verdict, and the row is `confirmed`.
  - `applyVerification` drops that check from `failed` too, and the stored rows keep only `verdict, failed, at`, so the table cannot say which confirmations rest on the app's point.
  - `compare` takes `found.reduce((a, b) => (Math.abs(b - appValue) < Math.abs(a - appValue) ? b : a))` over every price in the page text. A price is confirmed whenever some number within 2% of the app's is anywhere on the page (similar listings, a deposit, a price history).
  - The sea check uses the Natural Earth 1:10m coastline (`verifier/coast.mjs:4`), the same data as the app's fallback; CONCEPT says "from the OpenStreetMap coastline".
  - Not measured: how many of b7772e's 332 confirmed rows used the app's point (the per-check record is not in the snapshot).
- impact: the app guards its own place look-ups as error-prone (CONCEPT step 8: "a seller can put a Leiria plot on a Lisbon map"), and for those rows the outside check repeats the app's input and signs it. Row A5 (a deposit read as the price) passes the verifier by construction.
- fix: count "location source" in the verdict (the row stays `unconfirmed`, shown as "measured by the app, not confirmed outside"), or geocode the listing's stated place with the verifier's own code. For the price, read the listing's own price (JSON-LD offer or the embedded record of that listing id) first and use page text only when neither exists.
- test: `tests/verifier.test.ts` "a row located only by the app is not confirmed": `verifyRow` on a b7772e fits row with a page that has no coordinates returns `unconfirmed`.
- confidence: 0.75

### LEARNING-11. The reviewer can be the author's own provider, and nothing records who reviewed (row B5)
- class: design flaw
- severity: medium
- where: `src/llm/router.mjs:145-151` (`available`), `src/research/engine.mjs:1097-1108` (`critique`)
- evidence (verified by running): `return preferred.length ? this.demotePaid([...preferred, ...usable.filter((p) => p.id === avoid)]) : usable;` The author is always at the end of the list and is the whole list when the others rest.
  - Router with llamacpp and cerebras, `avoid: 'llamacpp'`: `['cerebras', 'llamacpp']`. With cerebras resting after a rate limit: `['llamacpp']`.
  - Ledger: of 291 answered `critique` calls, 14 came from llamacpp while every research answer of the preceding 3 minutes was also from llamacpp (gpt-oss-20b 5, qwen3.6-35b 5, nemotron-3.5 4).
  - `critique` stores `agree, severity, issues, betterAnswer` only. No stored piece carries the reviewer's provider, so the three researches cannot be checked for self-review.
- impact: "reviews it with a second model" and row B5 hold only while a second provider is open. A piece can reach `verified` with "reviewer agrees" from the model that wrote it, and the record does not show it.
- fix: store `critique.provider` and `critique.model`; when `reply.provider` equals the author, mark the critique `selfReview: true` and cap the grade at `supported`.
- test: `tests/research/engine.test.ts` "a review by the author's provider cannot verify": router stub returns the author's provider for `critique`; the piece grades `supported` and `critique.selfReview` is true.
- confidence: 0.8

### LEARNING-12. A scoped loop with nothing to try spins: about 12,000 project saves per minute until the deadline
- class: definite bug
- severity: low
- where: `src/research/improve.mjs:526-541` (`loop`), `:581-613` (`pass`), `:265-271` (`improvementTargets`)
- evidence (verified by running): when Q is excluded and every in-scope leaf is verified with no failing check, `improvementTargets` is `[]`, `pass` returns at once, and the `while (this.live(state))` body records a pass and writes a checkpoint with no wait. `plateauCheck` never fires because there are no trials.
  - Stored project with scope `['D4.1']` and the rest of the focus plus Q excluded: `targets []`. One simulated minute (5 ms charged per save): 11,998 passes recorded, 12,001 project saves, 0 trials, `stopReason: time limit reached`.
- impact: a loop the UI allows (select a piece, click the other highlighted pieces and Q to exclude them) rewrites the whole project file in a tight loop for up to 72 hours and reports "time limit reached".
- fix: in `loop`, end with `stopReason: 'nothing left to improve in the selection'` when a pass ran no trial.
- test: `tests/research/improve.test.ts` "a loop with no target ends at once": the setup above ends after 1 pass with that stop reason.
- confidence: 0.85

### LEARNING-13. SambaNova's daily limit is stated as 20 requests; it answered 38 of 38 on one day and is ranked as "spent" at 190% (row D3)
- class: definite bug
- severity: low
- where: `src/llm/ranking.mjs:149` (`DAILY_LIMITS.sambanova`), `:237` (`spent` in `purposePlan`), `:26`, `:155`; `src/llm/admin.mjs:13`, `:18`
- evidence (verified by running): ledger calls per UTC day for sambanova: 2026-11-02 43 calls, 39 answered; 2026-11-03 38 of 38; 2026-11-04 22 of 22.
  - `usageInfo` at 2026-11-03T23:59Z gives `{"requests":38,"limit":20,"used":1.9}`.
  - `spent` is `(usage[r.id]?.today?.used ?? 0) >= 0.9`, so after its 18th call of the day sambanova goes behind every other provider in all three purpose classes. It is the most reliable provider in the ledger (99 of 103).
  - Pollinations is labelled "1 reply per 30 s" in three places; its own error in the ledger says "Free limit reached: 1 reply every 45 seconds per IP" and the preset paces at 45,000 ms.
- impact: a working provider is pushed last for most of each day, and the Models & router page shows a limit the ledger disproves.
- fix: remove the request limit for sambanova (keep the note, re-dated, or take the limit from a 429 that names it); change the pollinations labels to 45 s.
- test: `tests/llm/ranking.test.ts` "a provider still answering is not ranked as spent": `purposePlan` with the ledger rows of 2026-11-03 does not place sambanova after providers with lower scores.
- confidence: 0.8

### LEARNING-14. The heap guard "restarts gracefully" by exiting, also when nothing will start the app again
- class: likely bug
- severity: low
- where: `src/server.mjs:515-518`, `:499-508` (`stop` ends with `process.exit(0)`); compare `src/app.mjs:492-496` (`restartForCode` checks `FRL_SUPERVISED`)
- evidence (by reading): `onHigh` logs "memory at N MB: restarting gracefully before it runs out (work is saved and the loop resumes)" and calls `app.onRestart?.()`, which is `stop('restart requested')`. `restartForCode` refuses to do this unless `env.FRL_SUPERVISED === '1'`; the heap guard has no such check. `start.cmd` shows no restart loop (grep for one found none; the file was not read in full).
- impact: on a Windows PC started with `start.cmd`, a long loop that reaches 1,024 MB of heap ends the app. The history says the loop resumes; it resumes only when the user starts the app again.
- fix: when `FRL_SUPERVISED !== '1'`, free memory instead (drop the loop page caches and the store cache, run the temp sweep) and write a note that names the command to install the always-on service; exit only when supervised.
- test: `tests/server.test.ts` "the heap guard does not exit an unsupervised app": with `FRL_SUPERVISED` unset, `onHigh` leaves `onRestart` uncalled.
- confidence: 0.6

---

Counts: 8 definite bug, 2 likely bug, 4 design flaw, 0 uncertainty, 0 ui (14 findings).
Most damaging: LEARNING-1 — the second measurement re-reads cached pages, so noise is always 0 (30 of 30 samples in b2f5b7) and the loop keeps changes on one measurement; LEARNING-2 and LEARNING-4 are the ones a user sees first.
Not checked: a live run (no network; routers, engines and providers were stubs); how many confirmed plots rest on the app's map point; the paid daily cap after a restart (no paid-provider rows, under 500 calls a day); loop cost per refused proposal (the ledger holds no `improve` calls); `provider.mjs`, `presets.mjs`, key saving in `admin.mjs`, peer watch and housekeeping were read in part and not run; the 3 loop trials stored as `error` are provider outages raised inside `commit` (`improve.mjs:756`), seen in data and not ranked.