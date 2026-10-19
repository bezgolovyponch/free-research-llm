# Improvement loop report · 2026-10-19

Research: `cars-to-sell-2000-4000-from-de-t-c97b3f`. Loop started from the app (`POST /api/projects/<id>/improve`, `{"hours":2}`), run only by the app's free-model router and free keys. No Claude tokens were used by the loop.

## Result

| Measure | Value |
|---|---|
| Window | 11:32 – 13:32 UTC, stopped by `time limit reached` |
| Score | 0.789 baseline → 0.878 best |
| Trials | 44: 9 kept, 24 reverted-whole, 8 reverted-piece, 3 error |
| Pieces | 31: 14 verified, 6 supported, 8 weak, 3 unsupported |
| Memo verdict | GO-IF at least one verified model (VW Golf) meets ≥15% net margin after landed costs |
| Expected-result check | 8 items delivered, pass/fail field empty (the check did not decide) |

Kept changes: Q (removed D5), D7.b, D7.a, D7.1, D1.2, D6.1.1, D2.2, D7.a, D2.3.

## Defects the run exposed

1. **The score rewards deleting pieces.** The first trial removed driver D5 (fraud and accident risk) and was kept. The score is an average of piece grades, so dropping weak pieces raises it without answering anything. Ticket C1 addresses this.
2. **The target list goes stale.** `improvementTargets` is computed once per pass (`src/research/improve.mjs`, loop). After D5 was removed, trials on D5.1.1 and D5.2 crashed with `Cannot read properties of undefined (reading 'id')` (2 of the 3 errors).
3. **Editing the tree leaves the phase at `done`.** `resetWithAncestors` (`src/research/engine.mjs`) clears the memo but keeps the phase, so the loop skips its baseline run and the first trial is measured against a stale tree.
4. **Repeated proposals.** "Use the listings tool" and "split into German and Czech" were proposed about 15 times; most were reverted. Nothing remembers a rejected idea per piece.
5. **Expensive rejection.** Only 8 trials were rejected by the cheap piece test; 24 needed a full re-score of the tree.

## Free-key usage in the window (621 calls)

| Provider | Calls | Failed | Average time |
|---|---|---|---|
| pollinations | 196 | 1 | 25.2 s |
| gemini | 186 | 71 (HTTP 429, quota) | 5.5 s |
| cerebras | 127 | 7 | 1.0 s |
| openrouter | 78 | 78 (daily quota spent) | – |
| groq | 32 | 11 | 1.1 s |

By purpose: research 212, critique 192, rollup 95, synthesize 63, improve 59. Critique costs about as much as research.

Source: `data/logs/model-calls.jsonl` and the project file, read after the loop ended.

## Recommendations, in order of effect

1. Coverage-aware score: removed or uncovered pieces count as 0; a removal is kept only if no regression check breaks (C1).
2. Reload the targets after every kept change.
3. Any tree edit sets the phase back to pending, so the baseline always runs.
4. A daily-quota 429 benches that provider until its reset time instead of retrying every 60 s (about 150 calls saved per run).
5. Run critique only when the gates disagree (about 30–40% fewer calls).
6. Remember rejected ideas per piece so each trial tries something new.
7. Route more research to Cerebras and Groq (about 1 s) and less to Pollinations (25 s); add free keys (Mistral, NVIDIA, SambaNova) and a search backend.
8. Feed real data to the weak D2.x import and transport pieces: official Czech fee pages and real transport quotes. Without them the `concrete` gate cannot pass.

Free models do not reason like Claude Max. The app closes the gap with mechanical gates, more calls per hour and better data, not with model quality.
