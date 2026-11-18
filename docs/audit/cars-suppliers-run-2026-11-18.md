# Cars 0c750f + suppliers b2f5b7 live run with owner findings as nodes (lead audit, 2026-11-18 ~17:10–17:30Z, main 123fed0)

Owner findings were given through each research's Chat (no code change): cars +D1 owner forums, D2 auction sold prices, D5 CZ price reports, D6 resale ranking (spec R1); suppliers +D7 options, D8 reseller forums, D9 per-kg price reports, D10 grading standards, D11 CZ brand resale prices (spec R5).

## Result
- Suppliers: D7–D11 all weak with 0 sources. Summary unchanged: 2 of 20 confirmed · 5 to confirm.
- Cars: D1 weak 0 sources; D2, D5 weak (4 sources each, claims not quoted: avcars.eu, auctionexport.com, goodcarbadcar.net, praguemorning.cz flats, paywalled market reports); D6 supported (acea tax guide, carvago depreciation article). Summary: 0 of 20 confirmed · 79 to confirm · 11 rejected (was 86/4).
- The gates were honest: every node without quoted evidence was marked weak.

## Engine causes (file:line on main 123fed0)
1. src/research/engine.mjs:938 gateOnKind drops every source whose text lacks the ITEM kind terms, for EVERY node. A knowledge node (forums, grading standards, price reports) can never pass: log "D10: 6 source(s) dropped before any model call — … not the asked kind (wholesale clothing supplier)", then "0 source(s) … analysing". This is why domain knowledge never reaches the tree or the judge (C8). Fix at the cause: a node has a source role — market (the items) or knowledge (how to judge/value them); gateOnKind applies to market nodes only; knowledge nodes are gated on relevance to their own question. Role is voted from the node question (closed vote, #212), no word lists.
2. src/research/engine.mjs:1124 knowledgeSourcesFor('used-vehicle') — a domain constant in engine code (violates engine-universal). src/research/knowledgesources.json holds only used-vehicle entries, so suppliers and plots get no curated knowledge sources. Fix: the concept comes from the decision model kind; curated sources are data, chosen by meaning; when none exist, knowledge nodes search by their question.
3. Knowledge search queries are weak: "grading standards cream A B" returned ncbi, qaa.ac.uk, fdic.gov, canlii. Queries for knowledge nodes must carry the item kind and the purpose (subject terms from the decision model), like groupQueryPrompt does for cars groups.
4. Old supplier nodes D1/D2/D5/D6 hold sources with an empty url ('') — evidence without a link; check where sources lose their url.
5. Acceptance is unchanged by any knowledge: checklist and verdict do not read node findings (same as C8/C9). Even when knowledge nodes succeed, nothing passes it to ranking or the judge.

## Zero-loss checks for the fix
Replay on stored copies: knowledge nodes get ≥1 quoted source each where the web has them; market nodes' kept/dropped counts unchanged (no new junk items); confirmed items unchanged or higher on labels; no domain words added to engine code.
