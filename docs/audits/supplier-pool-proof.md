# Supplier pool: hub search in rounds (2026-11-18)

Live signal: suppliers b2f5b7 on main ba474ac ended 7 of 20 confirmed from 21 delivered; its hub search ran once on 2026-11-17 (28 pages, 15 a country) and was reused for 7 days.

Witness: `node scripts/hub-witness.mjs find-the-wholesale-branded-secon-b2f5b7 --out <scratch>` on a copy of the live research after that run (free search and model keys, app router). It runs `searchHubs` and the same `entityDeliverables` call `checkAcceptance` makes. Output, verbatim:

```
hubSourcesBefore: 28
hubSources: 72
uniqueHosts: 61
deliverables: 43
hub round 1: 24 queries, 44 new pages, 38 new hosts
hub round 2: pool target reached (71 >= 60)
```

Round 1 queries were written per hinted country in its language and include the names of suppliers the kind judge had accepted (snowball), e.g. "vintage groothandel 25 jaar ervaring ReRags leverancier". New supplier hosts include vintagesupplyeurope.de, vintageandcream.de, asw-duesseldorf-gmbh.de, hurtubran.pl, odziezdunska.pl, odziezretro.pl, dimanoinmano.it, eurowearexport.com. Off-topic pages (netlify spam, trading sites) stay in the pool ranked last by BM25 and are left to the kind judge; nothing is dropped, so pages in the hinted countries' languages are never lost to an English query.

Tests: `tests/research/engine.test.ts` hub rounds (pool target, round cap, no new pages, no repeated query, snowball from judged suppliers only, directory paging cap, ranking without dropping, short result ignores the cache). Lesson F48.
