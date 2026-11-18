# Kind precision: second family on the company page, one company once (2026-11-18)

Live signal (suppliers b2f5b7 on main ba474ac, 2026-11-18 02:33Z): 7 of 20 confirmed, 21 delivered. vintagebulk.nl ("BEST SELLERS & NIEUW BINNEN"), palletliquidation.eu ("Used Clothing Bale Wholesale Pallets") and ukusedclothes.com ("Get a Quote") were rejected by one kind judgement on the home page and stored in `kindRejected` for good; tumodakids sl, wakted bv and liberty global exports were delivered twice, from europages.nl and europages.it.

What changed and the test that proves it:

| Change | Test |
|---|---|
| A kind "no" with a quote is read again on the company's own page (the existing `findRelevantLinks` of `deeper.mjs`, kind terms first) by a different provider family; yes with a quote replaces it, both no rejects, otherwise unknown; at most 30 second opinions per run | `tests/research/engine.test.ts` "a kind no needs a second family on the deeper page" (home no + company page yes → yes with the company page quote; both no → rejected) |
| `vote()` kept only its own avoid list, so a caller's provider to avoid was dropped and the second opinion could come from the same family | `tests/research/semantic.test.ts` "vote with a provider to avoid"; the engine test "asks the second opinion first of a family other than the one that said no" fails on the old `vote()` |
| `kindRejected` stores `{url, judgeVersion}`; entries from an older judge are forgotten (JUDGE_VERSION 3) | engine test "forgets rejections recorded under an older judge version" |
| One entity key per company id across language hosts of one directory (`directoryEntityKey` in `src/research/entitypath.mjs`, one owner of the entity path rule for `acceptance.mjs` and `deeper.mjs`) | `tests/research/entitypath.test.ts` with the live tumodakids pair |

The offline dry run cannot measure this change: it has no model router, so no kind judgement runs. The live rerun of b2f5b7 after merge is the measurement.
