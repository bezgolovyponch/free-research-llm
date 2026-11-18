# Plots b7772e: code-verified fits lost between the candidate table and the verdict (lead audit, 2026-11-18)

Evidence: stored data/projects/find-appropriate-plots-to-buy-fo-b7772e.json on main 123fed0 (candidates built 2026-11-18T14:41:54Z).

## What the data holds
- Candidate table: 1271 kept; 376 rows with plan.tier "fits" (code checked sea within 20 km by e-bike, 10+ camping months, no AC, 3+ units, real price trend above EU, location, legal path).
- Acceptance judged 51 deliverables, all from those "fits" rows. Result: 0 confirmed · 28 to confirm · 23 rejected.

## Where the values are lost (engine cause)
1. src/research/candidates.mjs:341 candidateDeliverables maps each row to {title, url, value: row.price, unit: row.currency, distanceKm, …}. It passes the RAW listing price and currency, and drops row.site (coastKm, climate) and row.plan.
   - row.value already holds the EUR-converted price (e.g. 120000 TRY → value 2166 EUR), but the deliverable carries 120000 with unit TRY.
2. src/research/checklist.mjs:352–375 ChecklistJudge.judge answers numeric items with MEASURES[measure].read(item) on that deliverable:
   - priceEur reads item.value → 120000 (TRY) compared with 20000 EUR → "no" → all 23 rejections are this one fault (quotes "priceEur: 120000 EUR", "priceEur: 1000000 EUR").
   - workableMonths / coastKm read item.site → undefined → "unknown" although the row has site.climate.workable 12 and site.coastKm 3.3.
3. The checklist bound the sea item to measure "distanceKm" (distance from the asker's place) instead of "coastKm".
4. Two measure tables: checklist.mjs MEASURES (no realTrendVsEu) and decision.mjs measures (has realTrendVsEu with ctx). The trend item has numeric null and is page-judged → "unknown", while row.plan.checks trend is computed by code.
5. "Suitable for glamping after preparation" is a hard page question; the code already computes its parts (plan.checks legal path, room for units). Entry cost incl. preparation (the Hints) is not computed per plot.

## Measured effect (offline, same stored rows)
With the row's measured fields: all 51 judged plots pass price (EUR), sea ≤20 km, ≥10 workable months and trend; 47 pass the kind check (4 unknown). Only the page question "suitable after preparation" stays unknown. So 0 confirmed is a wiring loss, not a lack of fitting plots.

## Fix at the cause (for the crucial-fixes session, as C12)
- candidateDeliverables carries row.value/row.unit (EUR) and the measured row fields (site, plan checks) — one owner: the candidate row is the evidence for code-measured criteria.
- One measures table (decision.mjs and checklist.mjs share it), including realTrendVsEu; checklist numeric items bind to the decision model criterion's measure (coastKm for sea), never to a model-chosen measure.
- Code-measured criteria are answered by code from the row; the page judge only answers what code cannot measure.
- Zero-loss check: replay on this stored project must move these 51 from rejected/to-confirm to confirmed where code measures pass, with no wrong confirmed (labels), and the verifier's 403 rows shown as "listing blocked, open yourself", not as live.
- Same check on cars (distanceKm, priceEur in CZK) and suppliers.
