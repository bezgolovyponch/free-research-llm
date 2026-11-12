# Restore plan: find-appropriate-plots-to-buy-fo-b7772e (2026-11-12)

Inputs:
- the qualification in [recover-b7772e.md](recover-b7772e.md) (PR #157);
- the restore command added by PR #158 (`node src/frl.mjs restore`, journal and snapshots);
- the plots audit [audit-plots-2026-11-11.md](audit-plots-2026-11-11.md).

Nothing in this plan has been run against real data.

## Decision: restore nothing

1. **No VALUE item.** All 68 pieces removed on 2026-11-11 were qualified: VALUE 0, COVERED 29, NO VALUE 39. No piece serves a stated criterion that nothing covers now, so no piece is to be restored or re-researched.
2. **The 18 qualifying plots were not lost to the removal.** 18 live Portuguese plots pass every hard criterion on their recorded values: price ≤ 20,000 EUR, asked country, coast ≤ 20 km, ≥ 10 camping months. None of them was in a removed piece; every kept row is a sweep row. They are outside the result because of two rules of the candidate table (`src/research/candidates.mjs`):
   - **7 cheap plots (500–3,800 EUR):** set aside by `implausiblyLow` (the MAD cut was 4,439 EUR for this table).
   - **11 plots at 17,000–18,000 EUR:** they fall past `MAX_KEPT = 1000`, since 1,453 rows passed the screen.

   Restoring the pre-removal state would not bring any of them back.
3. **The 2026-11-11 state cannot be restored anyway.** `frl restore` reads `data/projects/snapshots/` and `data/journal/`, and both start only when PR #158 is deployed. `data/handoff/` keeps the latest state only.

## The command the Mac runs

After PR #158 is merged and the app restarted, one read-only check:

```
node src/frl.mjs restore find-appropriate-plots-to-buy-fo-b7772e
```

With the id alone it lists the snapshots and the journal and changes nothing. It confirms that b7772e is now recorded: right after the deploy expect no snapshot, and a journal that starts at the first save after the restart.

**Do not run** `node src/frl.mjs restore find-appropriate-plots-to-buy-fo-b7772e --before 2026-11-11T16:15:00Z`. `--before` undoes every journal entry at or after the given time, newest first. All journal entries are later than the deploy, so this would undo every save made since the deploy and recover nothing from 2026-11-11.

## The 18 plots: what to do instead of a restore

- The URLs are in [recover-b7772e-urls.txt](recover-b7772e-urls.txt), with the per-row values in Section B of the qualification.
- They can be shown to the user as "pass every criterion, outside the table only because of table limits" without writing anything.
- The lasting fix is a code change (follow-up, not in this plan): a row that passes every hard criterion and whose page price equals the recorded price is exempt from `implausiblyLow`, and such rows are placed before the `MAX_KEPT` cut.

## Pieces that still refer to removed ones

| Surviving piece | Refers to | Verdict of the removed piece |
|---|---|---|
| D8.2.1.1.b | "the coastal districts identified in D8.2.1.1.a" | COVERED |
| D7.1.1.bx | "the parcels identified in D7.1.1.a" | NO VALUE (per-listing work the sweep does) |

Neither reference needs a restore. A user edit of the two questions (through the app, a user action) removes the dangling id.

## Follow-ups from the qualification (engine, not restore)

- Derive the seed portals and the region allowlist from the places the user names (`src/research/portals.mjs`, `src/research/candidates.mjs`). `SEED_PORTALS` has no Basque Country and no Vietnam portal, and sahibinden.com was dropped as outside the asked regions.
- Add a per-country preparation-cost rule to `entryCost` (`src/research/strategy.mjs`). The nearest-to-VALUE piece, D7.1.1.d, asked for water, power and clearing costs, which `entryCost` excludes.
