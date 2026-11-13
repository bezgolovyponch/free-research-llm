# Audit: b2f5b7 — why the supplier research gives no value on rerun (2026-11-12)

Date: 2026-11-12
Project id: find-the-wholesale-branded-secon-b2f5b7
Sources (read-only): data-main/projects/find-the-wholesale-branded-secon-b2f5b7.json, data-main/logs/project-find-the-wholesale-branded-secon-b2f5b7.jsonl
Scope: read-only audit of current main; no code changed. Prior audit: docs/audits/audit-b2f5b7-20261112-1337.md.

Rerun under audit: POST /api/projects/find-the-wholesale-branded-secon-b2f5b7/run at 2026-11-12T22:27Z. Log (project-...jsonl):
- 22:27:40.106Z "listings first: reading marketplace pages by code before any piece is researched"
- 22:27:40.117Z phase "researching sub-questions in dependency order"
- 22:27:40.127Z phase "writing the decision memo" (no node search/page-read in between — 8 s total)
- 22:27:48.836Z "expected result: 17%", memo "PROVISIONAL (low confidence; 11 pieces to fix, research or clarify)", phase done

Node statuses in the stored research: D1 weak, D1.1 weak, D1.2 supported, D2 weak, D2.1 weak, D2.2 weak, D3 supported, D3.1/D3.2 supported, D4 supported, D4.1 supported, D4.2 supported, D5 weak, D5.1 weak, D5.2 weak, D6 unsupported, D6.1 weak, D6.2 unsupported.

## 1. Why D4.2 (invented SKU numbers) and D4.1 ("0 brands present") are "supported"

The gate is verifyFinding in src/research/verify.mjs, graded at src/research/verify.mjs:176-185:
- line 182: a failed critical check means "unsupported"; line 183: any other failed check means "weak"; line 185: if nothing fails but verifiedWithoutMeaning (lines 190-192, needs 2+ cited web domains or a code-read data source) is false, the grade is "supported".

Both nodes pass every check, so they land on line 185 "supported" with score 100. The checks that should reject the content accept it vacuously:

- Attribution — src/research/verify.mjs:84-90 delegates to attributionSummary in src/research/attribution.mjs:35-42. Line 40: share = factual.length ? attributed/factual : 1, where factual = claims.filter(c => !c.assumption). D4.2's six claims are all assumption:true (attributeClaims sets attributed:null for them, attribution.mjs:27), so factual = 0 and share = 1, passed. Stored detail confirms: "0 of 0 claim(s) carry a quote found in the cited source", passed = true. D4.1 is the same: its single claim has assumption:true ("No mention of Ralph Lauren, Moncler, North Face, or Barbour in the provided evidence", value 0, sourceIds ["S1"]) so factual = 0 and attribution passes with 0 of 0.
- Numbers-sourced — src/research/verify.mjs:41-50, line 43 excludes any claim flagged assumption from "bare"; all six D4.2 numbers are assumption-flagged, so "6 numeric claim(s) traced", passed. D4.1's 0 is traced to the S1-cited claim.
- Concrete — src/research/verify.mjs:70-76 only requires the answer to contain a digit for a numeric metric; "Assumption: Supplier A carries 120 distinct Ralph Lauren SKUs, 80 North Face SKUs, 60 Barbour SKUs; Supplier B carries 100 ... 50 Barbour SKUs." and "0 brands present" both qualify.
- Citations — src/research/verify.mjs:29-39 only rejects source ids that were never retrieved; D4.2 cites none (0 ids, passes), D4.1 cites S1 which exists (passes).
- Grounded — attribution.mjs:54-64 allows every number that appears in any claim text/value; the invented 120/80/60/100/70/50 and the 0 all appear in claims, so it passes.

So "supported" here means only "no check failed and fewer than 2 independent domains were cited" — it does not mean the content is evidenced. Invented numbers labelled assumption:true and an empty "0 brands present" both sail through.

## 2. Why the rerun re-researches none of the weak/unsupported pieces

Route: src/server.mjs:221-228 POST /api/projects/<id>/run calls app.engine.start(id) (src/research/engine.mjs:1648-1656), which calls run(id) (engine.mjs:1479).
Inside run():
- engine.mjs:1513 resets only failed/researching nodes to pending — weak and unsupported stay as they are.
- engine.mjs:44: const DONE = new Set(['verified', 'supported', 'weak', 'unsupported', 'covered']).
- engine.mjs:1537 finished = (nodeId) => DONE.has(...) || status === 'failed', and engine.mjs:1548 "if (DONE.has(node.status)) return;" — every weak/unsupported node is skipped in the lane loop, so between the "researching sub-questions" phase (engine.mjs:1534) and the memo there is no search or page read, exactly as the 22:27Z log shows. The memo is then rebuilt (gaps.mjs:81 "11 pieces to fix") from the same stale findings and acceptance is re-measured (engine.mjs:1459, "expected result: 17%").

Deliberate? git log -L 44,44:src/research/engine.mjs shows the DONE set with weak/unsupported dates to the initial commit 3ffab25 ("feat: free research LLM app ..."); 832e2f8 only added 'covered'. scripts/process-lessons.json (13 lessons, F1-F13) contains no entry about reruns skipping weak/unsupported pieces — the nearest, F9, is about 'covered' pruning of analysis pieces, a different rule. So the skip is deliberate by construction (any graded node counts as finished) but undocumented as a known behavior; the rerun is designed to be memo-only.

## 3. Minimal fixes and proving tests

Defect 1 — verification gate accepts assumption-only / empty content as "supported".
- Fix: src/research/attribution.mjs:41, the passed field becomes: factual.length > 0 && share >= MIN_ATTRIBUTED_SHARE && numericMissing.length === 0 (an all-assumption claim set can no longer pass attribution; verify.mjs:183 then grades it "weak" instead of "supported"). Optionally also make verify.mjs:70-76 reject answers whose first sentence starts with "Assumption:" when the node expects a number.
- Test (tests/research/verify.test.ts, real text from this research): feed verifyFinding the stored D4.2 finding — answer "Assumption: Supplier A carries 120 distinct Ralph Lauren SKUs, 80 North Face SKUs, 60 Barbour SKUs; Supplier B carries 100 distinct Ralph Lauren SKUs, 70 North Face SKUs, 50 Barbour SKUs." with its six assumption:true, sourceIds:[], quote:"" claims, node with unit count, method lookup, metric "SKU count", sources [] — assert grade is "weak", not "supported". Second case: D4.1 — answer "0 brands present", one claim with text "No mention of Ralph Lauren, Moncler, North Face, or Barbour in the provided evidence", value 0, sourceIds ["S1"], quote "Top 5 Vintage Clothes Suppliers in Europe ...", assumption true, sources [one S1 entry with that text] — assert grade "weak".

Defect 2 — rerun skips every graded node, so weak/unsupported pieces are never re-researched.
- Fix: src/research/engine.mjs:1513 extend the reset to statuses failed, researching, weak, unsupported (set them to pending), so a rerun re-attempts exactly the pieces the memo lists as "to fix" (the within-run DONE skip at engine.mjs:1548 is unaffected because run() is guarded against re-entry at engine.mjs:1480).
- Test (tests/research/engine.test.ts, following the rerun pattern at line 811): with a ScriptedProvider, get a done project whose leaf is weak, call await engine.run(project.id) a second time, and assert the leaf's attempts incremented / its question appears in the provider prompts again — i.e. the 22:27Z log pattern (phase researching then memo with zero node searches) cannot reproduce.

Defect 1 cause+fix: attributionSummary (src/research/attribution.mjs:40-41) scores an all-assumption claim set as share=1/passed, so verify.mjs:185 grades invented or empty answers "supported" — require factual.length > 0 in passed (grade drops to "weak"); test with the stored D4.2/D4.1 findings in tests/research/verify.test.ts.
Defect 2 cause+fix: engine.mjs:44 DONE includes weak/unsupported and engine.mjs:1548 skips them while engine.mjs:1513 resets only failed/researching, so POST /run on a done research is memo-only — reset weak/unsupported to pending at engine.mjs:1513; test a second engine.run re-attempts the weak node in tests/research/engine.test.ts.
Risk: downgrading assumption-only answers to "weak" and re-researching weak pieces on every rerun will lower displayed grades/scores and lengthen reruns (more model calls) — intended, but memo "pieces to fix" counts and acceptance scores will move on the next rerun.
Proof plan: add the two verify.test.ts cases with the verbatim D4.2/D4.1 findings and the engine.test.ts rerun case, run npx vitest run tests/research/verify.test.ts tests/research/engine.test.ts, then re-run this research via POST /api/projects/find-the-wholesale-branded-secon-b2f5b7/run and confirm the log shows node searches between "researching sub-questions" and "writing the decision memo".
