# Purpose tree on the live path: witness on stored researches (2026-11-18)

`node scripts/purpose-witness.mjs <id> --out <scratch>` copies the stored research, loads keys as the server does, runs `engine.ensurePurposeTree` (scoping when notes are missing, then the purpose tree, then the decision model rebuilt from it) and `engine.checkAcceptance`, and saves the result in the scratch copy. Free models only, through the app router. Counts below are read from that saved copy and from the script's JSON output.

## Baseline (live app on main 1c3d2b2, before this branch)

| Research | Confirmed | To confirm | Rejected | Hard checks |
|---|---|---|---|---|
| suppliers b2f5b7 (2026-11-17 22:03Z) | 0 of 20 | 1 | 15 of 16 | every clause and the hint: brands similar 0/16, location hint 5/16, graded 11/16, per kg 12/16, proven quality 16/16 |
| cars 0c750f (2026-11-16) | 0 of 20 | 32 | 58 | accurate and verified listing, hatchback, engine information, trusted sources, crucial metrics |

## Rounds that changed the code

| Round | Found on the witness | Fix |
|---|---|---|
| tree v2 | location hint and an invented "delivery within 24 hours" were hard; "brands similar to" became one exact brand; "graded A/cream" read as dairy | hard only from a question clause voted constraint or a number the user wrote; item kind and domain terms named in every tree prompt (eb88445) |
| tree v3, cars | invented "reliability score >= 300 points" counted as asked because the question says 300 km; the clause holding "at least 20 cars" voted constraint, so every page question under it vetoed | a number is asked only with the unit written beside it; counts are ignored by the hardness vote; a hard numeric needs a measure code reads (50cb185) |
| tree v3, both | Gemini embeddings answered 401 on every call (the key list was sent as one key), so the tree ran out of calls and left the user's clauses unmodelled | embedder sends one key of the list at a time (50cb185) |
| tree v3 clean, suppliers | core clauses C1/C2 still not modelled; five live suppliers that passed the kind check were rejected by the lexical "page mentions one of the named brands" check | every uncovered asked clause becomes a goal; under a purpose tree the named-brand check scores, never vetoes (67ef503) |

## Clean witness (embeddings working, tree v3)

Suppliers b2f5b7: 9 goals, no hard item but the kind check; 12 delivered, 3 confirmed (wintageclub.it, skullwholesale.com, vintagebulk.nl), 9 rejected. Of the 9, 2 failed the kind check with a quote ("Alle Producten en Diensten"), 5 were rejected only by the named-brand check that 67ef503 turns into a score, 2 were a marketplace ad and a duplicate directory profile. Only 12 suppliers were delivered because the witness opened fewer pages than the live app (35% live links against 80%); the live rerun gives the real pool.

Cars 0c750f: 8 goals; hard items are exactly the user's constraints: hatchback stated on the page, distance from Prague <= 300 km (`distanceKm`), price <= 65000 CZK (`priceEur`). 90 judged: 7 confirmed (Seat Ibiza, Kia Picanto x2, Opel Corsa x2, Skoda Fabia), 31 to confirm (body type not stated on the page), 52 rejected (kind check: 40 pages are not one hatchback offered as asked).

Open after this branch: the same listing can be delivered twice (Kia Picanto); C5 of the car question was still not modelled on tree v3 (covered from tree v4 by 67ef503); the live rerun of both researches is the acceptance test.
