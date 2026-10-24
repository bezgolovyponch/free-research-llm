# Session log

How this app was built, what each session decided, and what is still open. Newest first.
Run-time history of your own researches is in the app (**History** tab) and in `data/logs/`.

## 2026-10-20 · session 16 — tree audit (structural gate), diverse piece chat

- **Asked:** the tree levels are wrong (screenshot). Audit the decomposition engine and use verification harnesses on it. Make the piece chat more diverse and fix its UI.
- **Audit of the glamping-plot tree:**
  - every leaf depended on its own parent (`D1.1 → D1` …), which drew the dashed lines over the tree lines;
  - the loop added three near-copies of the whole question as drivers (D6–D8) and kept them;
  - titles carried ids ("D7: …", hence "D7 D7:" in the chat);
  - D1–D5 had one sub-question each, while other pieces went a level deeper;
  - "Parcel identification" sat under bike infrastructure.
  - The same check over all 9 distinct trees found the same defects in older ones too.
- **Built: a structural gate** (`src/research/treeaudit.mjs`), the same principle as the quality gate (mikoshi-construct: the gate decides, not the author).
  - Checks: duplicate or overlapping siblings (Dice overlap on stemmed words; pieces naming different places or entities are never duplicates), a driver restating the question, single-child splits, depth > 3, more than 7 drivers, misplaced pieces, ids in titles, dependencies on the own branch.
  - Auto-repair (`repairTree`) for ids in titles and own-branch dependencies, at tree build and at the start of every run.
  - Building the tree is verified and revised: on failure the model gets the failures and is asked once more, and the tree with fewer issues is kept.
  - The loop's added drivers and splits, chat-added pieces, splits and researched suggestions are refused when they duplicate an existing piece.
  - The audit is sent with every project; **Gates & logs** shows a Tree checks card (problem plus fix), the map shows a ⚠ button, and own-branch dependency lines are no longer drawn.
  - Tests include a fast-check property test: for any random tree, repair leaves no own-branch dependency or id prefix, and never adds or loses a node.
- **Piece chat:** it must be specific to the piece (entities, evidence, concrete next searches) and never propose a duplicate. Suggestions use the diverse source selection and drop duplicates. While a loop is running, the waiting bubble says it is pausing the loop. The desired-output field has a label and no browser autofill (the empty white box over Send). Titles are shown without ids.
- **Demo:** the demo split now returns two different sub-questions (the old A/B pair was correctly flagged as a duplicate).

## 2026-10-20 · session 15 — maximum-capability routing; the app is no longer car-specific

- **Routing** (more free keys): the new default strategy **Maximum capability** routes by purpose, combining FrugalGPT's cascade (Chen et al. 2023) with LiteLLM-style quota-aware routing and fallbacks for prompts too big for a model.
  - Memo, tree and code go to the strongest model; research to capable models with volume; reviews and roll-ups to fast models of a different family than the author. Escalated research (`research:deep`) goes to the strongest.
  - The strongest model's quota is kept for the important calls once it is 70% used.
  - Benching: a 402 or a daily-quota error waits for the next UTC day; 401/403 waits 6 h. SambaNova's `402 balance_units:0` was retried on every call before.
  - Prompts over 7,000 tokens skip Groq (its 8K TPM, the cause of HTTP 413).
  - The router page shows the three lanes, the reserved model, and why a provider is benched. Code: `purposePlan`, `familyOf` (`src/llm/ranking.mjs`); `ordered(tier, purpose)`, `coolDown` (`src/llm/router.mjs`).
- **Car arbitrage removed from the app** (the research data is kept and still opens): the car-arbitrage template, the marketplace reader (kleinanzeigen.de, bazos.cz, aaaauto.cz, `src/search/marketplaces.mjs`) and its robots.txt policy, and the `listings` tool in tree, engine, loop, chats and prompts. Placeholders, chat hints, the guide card, the demo, README, GUIDE and PROTOCOLS now use neutral examples.
- **Flaky e2e cause:** DeepSeek Harness, running e2e for another repo (`~/DVOR-8`), runs `pkill -f chrome-headless-shell`, killing this app's test browsers mid-run.

## 2026-10-20 · session 14 — diverse, entity-specific research instead of generic content

- **Asked:** review the latest run, whose content is generic, and patch the app for more diverse results.
- **Review of the DeepMedChem run** (25 pieces: 3 verified, 1 supported, 17 weak, 1 unsupported, 3 pending):
  - the tree asked for figures only the company has (cash burn, EU market share, break-even);
  - queries were generic ("SaaS subscription break even formula");
  - off-topic pages were accepted (grafana docs, a netlify spam page, change.org, "ai-in-blockchain");
  - 9 of the top 15 domains were market-report teaser sites, and only 5 of 178 sources came from the three named companies;
  - the prompt's "hypothesis to test" anchored the answers.
  - **Code causes:** search kept the first results until the budget filled (the first query dominated); there was no per-site cap and no source-quality tier; no company-scoped queries.
- **Patched:**
  - **Source selection** (`src/search/selection.mjs`, used by `SearchService.search`). It is MMR-style (Carbonell & Goldstein 1998): candidates come from every query, then relevant and different sources are picked.
    - Tiers: the companies' own sites, code, papers, registers and press releases are primary; market-report teasers and spam hosts are low, at most 2 per piece.
    - Limits: at most 2 sources per site; pages sharing no word with the piece are dropped; pages that never name the piece's companies rank lower; sites other pieces already use are penalised.
  - **Queries:** `site:` queries for the named company domains, and company names added to queries that leave them out.
  - **Owner-only figures:** a private company's own figures are not searched; the piece goes to **Clarify** with "owner input".
  - **Prompts:** perspectives as in STORM (Shao et al. 2024); leaves must name entities and public evidence; internal figures go to "assumptions to confirm". Research no longer sees the hypothesis, must not give generic advice, opens with the finding and prefers primary evidence.
  - **New `competitive-strategy` template** (competitors' capabilities, customers, pricing, partnerships, gaps, constraints). It is chosen for competition, strategy and action-plan questions.
- **Live check** (real search keys) on the pricing-gap piece: before, the sources were saastr.com and twbrian.wordpress.com. After: boltz.com pricing, cheese.deepmedchem.com pricing, docs.boltz.com, arxiv.org, genengnews.com, a talk comparing Boltz with Isomorphic Labs — 8 relevant sources from 6 sites.
- **Open:** existing pieces keep their old sources until re-researched. The running research keeps its market-sizing tree until it is rebuilt.

## 2026-10-19 · session 13 — Node 24, dependency PRs

- **Merged** Dependabot PR #1: GitHub Actions `checkout`, `setup-node` and `upload-artifact` updated to v7. Green on Node 22 and 24 after a rebase; the earlier red run was one flaky e2e test.
- **Node 24 on this Mac:** `brew install node@24`, unlink node@20, link node@24 (24.22.0, npm 11.19.1). Then `npm ci` and the gate PASSED. npm 11 blocks dependency install scripts, so `allowScripts` in `package.json` approves `node-pty` and `esbuild`; the terminal's `node-pty` was checked to open a pty.
- `engines` is now `^22.12.0 || >=24.0.0`, with GUIDE, README and OSS-REVIEW updated. The always-on service was re-registered on Node 24. Its plist points at Homebrew's stable `opt` link (`stableNodePath`), so a `brew upgrade` no longer breaks it.
- **Flaky CI e2e, found and fixed** (from the Playwright traces of the failed runs):
  - On a phone, a long research list pushed the model status and the router **+** below the screen ("outside of the viewport" ×113). They now sit at the top of the drawer.
  - The router page re-rendered 8 s after opening (link checks) and threw away typed keys and in-flight clicks. Typed values and focus now survive re-renders, and the delayed refresh is skipped once the user has touched the page. The e2e case types a key and checks it is still there after 8.5 s.
- **PR #2** (vitest 5) is merged once its CI is green on Node 22 and 24.

## 2026-10-19 · session 12 — results computed from the current pieces, with probabilities

- **Asked:** results were inappropriate. They must come from the pieces and sub-pieces, be regenerated after every run and update, and give the most probable result the research supports. Also: why can only Claude Code change the app?
- **Core issues found in the DeepMedChem action-plan research:**
  1. Non-answers passed the gates: D1.3 and D4.2 were *verified* and D1.1, D2.3 and D5.x *supported*, while their answers say "not established by the supplied evidence", "hypothesis is not validated", "not directly reported".
  2. A plan question was forced into GO/NO-GO, and the model copied the prompt placeholder (`GO-IF <…>`).
  3. The Results chat answered from an older memo.
  4. An edit set the memo to null while the phase stayed `done`, so results vanished and the loop skipped its baseline.
  5. Nothing weighted the result by evidence strength.
- **Built:**
  - **Stricter gate:** `isEvidenceGap` in `src/research/verify.mjs`, applied to the first sentence and tested on the real answers. `engine.regrade` lowers finished pieces at the start of each run, and their parents are rolled up again.
  - **Computed result** (`src/research/result.mjs`, sent with every project and SSE update via `withResults`):
    - each grade becomes a probability (verified 0.9, supported 0.75, weak 0.4, unsupported 0.15), combined up the tree by weighted log-odds, extremized ×1.5 when sources are combined (Satopää et al., 2014; one source keeps its own value);
    - the question type is detected (plan, decision, estimate, list);
    - plans: actions ranked by probability × impact, from the pieces each cites;
    - decisions: options scored by consistent minus inconsistent evidence (Analysis of Competing Hypotheses, Heuer).
  - **Memo:** the prompt returns `actions` or `options` for the question type; placeholders are stripped.
  - **Out of date memo:** the memo keeps a basis hash per piece, and Results lists the pieces changed since it was written. **Rewrite memo from current pieces** calls `POST /api/projects/:id/synthesize`. A tree edit now keeps the old memo and sets the phase to `tree-ready`, so the loop re-runs its baseline.
  - **Results chat:** it gets the computed result and is told to trust it over the memo. Answers written before the current result are marked.
  - **App chat rule 4b:** it now says both implementers can edit the UI, server, tests and docs; Claude Code is more reliable, the free models cost nothing.
- **Live:** the DeepMedChem research is now plan type, 26% evidence probability, 7 pieces regraded. The rewritten memo by free models gives the verdict "Accelerate delivery of the three core AI chemistry features within 6 months", with five ranked actions from 35% down to 17%, each citing its pieces.

## 2026-10-19 · session 11 — exact steps everywhere, Claude Code shell limits, clean-up

- **Asked:** guidance like "NVIDIA: open the marketplace" is not enough; every suggestion in the app must be an exact, ready-to-execute instruction. Then: clear temp and cache files; the App assistant should change the app the way this chat does; review open-source solutions and bring the app up to standard.
- **Found:** a second agent (DeepSeek Harness) was editing and committing this repo at the same time (21:08–21:42, including the chat-to-code work and `OSS-REVIEW.md`), and it overwrote a change in progress. The user chose one editor from now on.
- **Exact steps:** the App chat now receives the dated key steps for every missing key. Its rule 6 requires ready-to-run steps, never "go to the website". The reply audit accepts the guide links and commands (`guideUrls`, `guideCommands`, `guidesText` in `src/llm/guides.mjs`). The Results action plan names the exact control (Re-research on this row, ▶ Run, Clarify in chat, Instructions & pages to read → Save, Split further). Audit check O12 was added.
- **Security fix:** the Claude Code runner passed `--allowedTools ...,Bash`. The Claude Code docs say a bare `Bash` rule "matches all Bash commands", so a chat-started run could run any shell command unattended. It is now limited to `npm run quality`, `npx vitest *`, `npx playwright test *`, `node --check *` and `ls *`. `git push/commit/reset`, `rm`, `curl`, `wget`, WebFetch and WebSearch are denied (`CLAUDE_ALLOWED_TOOLS`, `CLAUDE_DENIED_TOOLS`).
- **App assistant works like a live session:** Claude Code now runs with `--output-format stream-json --verbose` (event format checked with one real Haiku call). Every 20 s the App chat gets what it did since the last note, e.g. "read 3 files · edited public/index.html · ran npm run quality · says: …" (`describeEvent`, `ProgressLog`). Both coders end with "What changed:" listing each file's added and removed lines, and which files are new (`diffStats`).
- **Review of the DeepSeek Harness commits, and fixes:**
  - `promote` copied every sandbox file that differed from the live app, so a run could silently revert files changed meanwhile. It now promotes only files whose content changed since the sandbox was prepared (sha256 baseline), and refuses if those files also changed in the app.
  - Protected files (gate, coder, auth, secrets, terminal, `package*.json`) were guarded only by prompt text. A change touching them now fails before anything is written (`PromoteError`).
  - Windows: the prompt now goes to `claude -p` on stdin (checked with one real call) instead of an unescaped `cmd.exe` argument. The arguments are quoted (`winQuote`), and a timeout kills the whole process tree with `taskkill /T /F`.
  - The CI workflow is fine: read-only permissions, `persist-credentials: false`.
  - Live check: the App assistant answered a change request with a Claude Code ticket proposal, and the reply audit passed. The run itself was not pressed, so nothing was spent.
- **Clean-up (approved by the user):** deleted this session's scratch files, test results, the Hugging Face, Gradle (caches and daemons), Codex, npm and Homebrew caches. 1.5 GB freed; 52 GB free. `~/.cache/chroma` was kept (the running memory plugin uses it). Docker was not running, so `docker system prune` was not run.

## 2026-10-19 · session 10 — change the app by talking to it (Claude Code or free models), and repository standards

**Asked:** (1) revise how the AI chats work so a change can be made from the App assistant the way one works with a coding agent — describe it in the chat and have UI and features changed, with follow-ups. (2) Review ready-made open-source solutions, then optimise and bring the project up to standards.

**Built:**
- **Two implementers for one app change.** A change proposal now offers **Implement with Claude Code** (primary when the CLI is installed; uses the Claude plan) and **with free models**. Both are selected per task; the ticket remembers which one ran (`engine`).
- `src/coder/claude-code.mjs`: Claude Code runs inside the same sandbox copy (`data/work/C<id>`) with `--permission-mode acceptEdits`, a tool allowlist, a hard 45-minute limit and a kill, no skip-permissions flag, and no network writes into the app. The gate failure goes back for a second run; if no file changed and Claude failed (for example the plan's session limit), the ticket fails with that exact reason instead of pretending a change happened. Cost from Claude's JSON output (`total_cost_usd`) is reported in the chat and on the ticket.
- `src/coder/runner.mjs` dispatches by engine, reports which implementers are available, refuses a missing one, and undoes with the engine that applied the change. `/api/status` exposes the list; `POST /api/changes/:id/run` accepts `{engine}`; `GET /api/changes/:id` returns the ticket and its attempts.
- `promote` now sees files an agent edited directly in the sandbox (walks the copy, ignores `test-results/`, `playwright-report/`, `data/`), not only files the free coder marked as touched.
- Chat and UI: proposal buttons per implementer; App changes shows the engine, state, gate summary, **Undo** and **Try again** (with either implementer); the prompt knows which implementers are installed and that a follow-up becomes the next ticket.
- Docs: CONCEPT (how the two implementers work, the gate stays the only write path), GUIDE (a "Change the app by talking to it" section), README layout, and [OSS-REVIEW.md](OSS-REVIEW.md).
- **Repository standards:** `.github/workflows/ci.yml` (job `test`, Node 22 and 24, `npm ci`, Playwright browsers, the full gate, failure artifacts), fail-closed e2e when `CI` is set, Dependabot (npm + actions), `SECURITY.md`, `CONTRIBUTING.md`, `.editorconfig`, `.gitattributes`, bug-report and PR templates.

**Verified:** `npm run quality` PASSED (248 unit tests, 18 e2e). Live, on a temporary second instance (temp data dir, real Claude CLI): asking for a change produced the ticket; with the plan exhausted, the run failed with the exact text "You've hit your session limit · resets 9:40pm", the chat said "stopped before any edit … the app is unchanged", and no file changed. After the limit reset, the same path ran for real on a temporary ticket (`ChangeBook` + `ClaudeCodeCoder`, temp data dir): Claude edited the sandbox, `npm run quality` PASSED there (249 tests, 18 e2e, including a test it added), the change was promoted and the run cost $0.34 on the Claude plan. That test edit was reverted afterwards; the repo is unchanged. CI ran on GitHub: both jobs (`test (node 22)`, `test (node 24)`) green in 2m0s and 1m40s, and again green after bumping the actions to v5.

**Open:** Claude Code added a test file the ticket did not ask for in that verification — harmless and gate-passing, but it is exactly what a diff-before-apply review would catch, so that step is the next candidate. `engines` still says Node >=20 while Node 20 is end-of-life; CI tests 22 and 24. A linter (Biome, lint only) is analysed in [OSS-REVIEW.md](OSS-REVIEW.md) but not added. Dependabot opened its first PRs while this session ended (vitest major, actions group); both pass the CI gate but were left for the user to merge.

## 2026-10-19 · session 9 — how to get each key, in the app and the terminal; one SearXNG command

**Asked:** the router cards said "Get a free key" but not how to get one, and the exact clicks lived only in KEYS.md. Put the steps where the key is pasted (router cards, the Setup key box, the terminal), for every model provider and search engine, with what a key starts with, which ones need a card, and when the steps were checked. SearXNG setup was a macOS-only `.command`; make it one command that also works on Windows and from the app Terminal.

**Built:**
- `src/llm/guides.mjs`: numbered steps, the sign-up page, a documentation source, the key prefix, a card warning and a note for every provider, the extra Cloudflare account ID and every search engine, plus llama.cpp, Ollama, FreeLLMAPI and SearXNG (`GUIDES_CHECKED` 2026-10-19). `guideFor` and `guidesFor` look a guide up by the exact variable name.
- Router: every model and search card has **How to get it** (open when the key is not saved) with linked steps, `Key starts with …`, `needs a credit card` and "Steps from the provider's docs, checked …"; the **Manage key** box of a saved provider repeats it.
- Setup & keys: the key box shows the same numbered steps for the selected provider or engine instead of only a signup link, and says a pasted key lasts until the app stops, with a link to Models & router where it is tested and saved in the key store.
- Terminal: `node src/frl.mjs keys list` and `keys set NAME` print the steps before the prompt. `node src/frl.mjs searxng` starts SearXNG in Docker from `~/.config/free-research-llm/searxng` (limiter off, JSON on), waits until it answers, saves `SEARXNG_URL` in the key store and reloads the running app; `searxng.command` now only calls it and **Terminal → Start SearXNG search** runs the same. README, GUIDE.md and KEYS.md point at both.
- Optional keys: `optionalKeyEnv` (Pollinations) is a known secret name now, so a pasted optional key is saved and the card shows it as saved.

**Verified:** `npm run quality` PASSED (240 unit tests, 16 e2e). Live on the running app after `frl restart`: `/api/status` carries 23 guides and `/api/router` a guide on every provider and search row; in Setup & keys the Groq box showed 4 numbered steps (the first screenshot showed the numbers were missing — `padding:0` hid the list markers — fixed with the existing `ol.steps` style), and the SearXNG steps showed the Docker and `searxng` commands.

**Open:** the steps were checked against each provider's own documentation, not by creating an account on every provider; re-check them when a provider redesigns its console. SearXNG was not started in this session (Docker Desktop was not answering), so the container start is unverified on this machine.

## 2026-10-19 · session 8 — free-key loop review, C1, free-model coder

- **Asked:** run the loop on free keys and review it; store the report; make app changes run on the internal free models instead of Claude Code, autonomously.
- **Loop (free keys only, 2 h):** score 0.789 → 0.878, 44 trials (9 kept). Report: [Improvement_loop_report.md](Improvement_loop_report.md).
- **C1 (coverage-aware score):** started in the Terminal with Claude Code, stopped on the user's request. Its edits (`src/research/score.mjs`, `src/research/improve.mjs`, `tests/research/improve/*.test.ts`) were kept and pass the gate.
- **Free-model coder (`src/coder/`):** App chat tickets are now implemented by free deep models in a sandbox copy. Code applies the edits there, runs `npm run quality`, retries up to 4 times with the failure, and copies the files into the app only on PASS, with a backup and an Undo button. The coder cannot edit the gate, itself, auth, secrets, the terminal or `package.json`, and a change that removes tests fails. `node src/frl.mjs change C<n> --claude` keeps the Claude Code path.
- **Live test of the free coder (C2, "Loop trials (N · K kept)" heading):** 3 runs, all on free keys and none passed the gate, so the app was left unchanged and the sandbox was removed. The fixes it led to: code-side file search (the model first edited the wrong files), excerpts of large files, a whole-file rewrite refused on large files, failing-test detail fed back, a per-attempt log, and a clear message when quotas are spent. In the last run the right file (`public/index.html`) was edited twice with 10/12 e2e passing; then OpenRouter timed out, Pollinations hit its token limit, and Cerebras and Gemini were out of daily quota.
- **Researches list:** one row per main research (the newest run of each question): name, start time, active dot, node count. Nothing else.
- **Selected-pieces loop:** **Select pieces** on the map, with the focus path highlighted and exclusions (dashed red). **Improve loop ▾** is a dropdown: Entire research / Selected pieces. Focus = Q, the primary level, the siblings along the path, and the selected piece's sub-pieces, minus exclusions (`inScope` in `src/research/improve.mjs`). The loop reloads its targets after every trial, so removed pieces no longer crash it.
- **Free routing:** [FREE-ROUTING.md](FREE-ROUTING.md) puts FreeLLMAPI (MIT, 34 providers, per-key daily counters) in front of the app as the `custom` provider. New `node src/frl.mjs keys set NAME`; the key store also holds `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_MODEL` and `FRL_PROVIDER_ORDER`.
- **Models & router menu:** a **+** next to the models indicator (and on Setup) opens a modal listing every free model provider and search engine. Each row shows its free tier (checked 2026-10-18), a source link the app checks live, a key input, Save & test (the key is tested with the provider before it goes into the key store), Test, Remove, live state (works / cooling / not working / no key) and this session's calls. It also sets the router order: tick and reorder providers, then save (`FRL_PROVIDER_ORDER`). `src/llm/admin.mjs`, `/api/router*`. Signup links fixed: Pollinations → enter.pollinations.ai, Serper → serper.dev/api-keys. The phone drawer now scrolls.
- **Always-computed result:** the memo prompt no longer allows a bare "INSUFFICIENT DATA"; it must give a verdict and a best estimate with a range. `src/research/gaps.mjs` marks the result provisional, sets a confidence from the checks, and lists every unsettled piece as Fix / Research further / Clarify, with why, the next step and a priority (impact × uncertainty × grade gap; pieces the memo cites first). A provisional memo earns half the loop's decisive bonus.
- **Export:** the Results tab exports the report (.md), pieces & actions (.csv, spreadsheet-safe), delivered items (.csv), everything (.json), and print/PDF.
- **Router page rebuilt** after "no logic behind the placements". It follows FreeLLMAPI's Models page, where the list order is the live routing order and each model shows reliability, speed and intelligence, plus OpenRouter's sort option. A **Routing strategy** selector offers Balanced / Fastest / Smartest / Custom. **Deep role** and **Fast role** each show their ranked route: rank, model, 24 h reliability bar, median speed, capability ★, and a one-line reason for each place. Summary tiles show connected / ready / cooling / calls / worked / rate-limited. Provider cards come below. `src/llm/ranking.mjs` scores from the call log, which is reloaded on start. The router's order is re-ranked every minute.
- **Local GPU (from the "iPhone as a second GPU" Reddit post):** the post is Backburner (MIT; Mac + iPhone over USB-C; llama.cpp fork; +29–44% prefill, flat decode). Built the Windows equivalent on stock llama.cpp:
  - `node src/frl.mjs local install / models / start / helper / status / bench`, in `src/local/llamacpp.mjs`: official builds, sha256-checked;
  - helper devices through the llama.cpp RPC backend, private addresses only;
  - router provider `llamacpp`, with capability rated by model size and tiny models kept last.
  - Verified on this Mac: install, helper + server with `RPC0`, bench 518 tok/s prefill and 82 tok/s decode, router listing.
  - Docs: [LOCAL-GPU-PLAN.md](LOCAL-GPU-PLAN.md) (analysis, plan), [LOCAL-GPU.md](LOCAL-GPU.md) (Windows guide).
  - Not verified: a real Windows PC, CUDA, Android helper.
- **Open:** C2 is ready for Try again after the quotas reset; stale loop targets after a removal; the expand phase bug; 429 benching; critique cost (see the report). Stray "compile .exe" researches still need deleting by the user.

## 2026-10-19 · session 7 — tree & pieces layout, request + desired output, regression checks, scoped loop, app changes from the App chat

**Asked:** left researches; middle tabs: decomposition/dependency map, tree (left) + pieces table and per-role reports (right), sources per piece, gates & logs; all threads and interactions on the right; checkboxes in the tree to run the loop on the whole research or selected pieces; Node and Research chats always with request + desired output for reverse engineering and regression tests. Mid-task: the App chat is responsible for all app changes (features, tests, checks), the main terminal for the app. User decisions: table + selected report; desired output → stored checks; per-research Gates & logs tab.

**Built:**
- Middle tabs: Decomposition map · Tree & pieces · Sources · Results · Report · Gates & logs. Pieces named as in the first version (Q, D1 drivers, D1.1 sub-questions) with role. Per-role reports (research process for sub-questions, roll-up for drivers, decision for Q). Right panel: piece actions, files, instructions, chats.
- `src/research/specs.mjs`: desired output → regression checks (grade, number, range, items, words), evaluated after every run, "regressed" when a passing check fails.
- Loop: scope = whole research or ticked pieces (+ sub-pieces), scope score, regression revert in piece and whole tests; scope survives chat pauses and restarts.
- Node/Research chats require request + desired output; the loop prompt sees the desired outputs.
- App change tickets: App chat proposes `change`; on the button `data/changes/C<n>.md` + `node src/frl.mjs change C<n>` (Claude Code, then the quality gate, result posted to the App chat). `src/changes.mjs`.

**Verified:** `npm run quality` PASSED (185 unit tests, 12 e2e). Live: the App chat turned "add a CSV download to Results, with a test" into a change-ticket proposal (no ticket before the button); new layout screenshotted on the running app.

**Open:** the two stray "compile .exe" researches still need deleting by hand; ticket runs need Claude Code installed on the computer that runs the app; Windows/cloud not run on real machines.

## 2026-10-19 · session 6 — separate chats, reply audit, Results tab, files in chats, terminal, Windows and cloud

**Asked:** (1) remove the research the App chat created by mistake and make that impossible; app conversations only in the App chat, never mixed with research, piece or results chats; go through the flows and cut bad behaviour. (2) A Results tab with its own chat; upload and recognition of files and photos in chats. (3) An exact document for Windows. (4) How to run it always on in a free cloud. (5) A mandatory audit protocol, run at the start of every task and before every result. Mid-task: (6) a master terminal behind a button that replaces `start.command`/`keys.command`, usable from macOS and Windows at the same time. Decision by the user: a real shell from any device, protected by the access token; chats may only propose commands.

**What was wrong (from the App chat thread):** invented links (`app.example.com`), invented keys (`API_KEY=abcd1234`), "I'm opening…" with nothing opened, two "compile an .exe" researches created from requests that were not research, "removed" claimed while nothing was removed, a `git commit -m "Your commit message"` instruction that was followed. Cause: the App chat had no facts or documents, could create researches by itself, and nothing checked its replies.

**Built:**
- Four chats with separate threads: piece, research, **results** (new), **app**. App questions sent to a research chat are answered in the App chat (`scope: "app"`). App reports (started, keys reloaded, research created / finished / deleted, loops, resumes) go to the App chat. [CONCEPT.md](CONCEPT.md).
- App chat grounded in code-checked facts, a search over the app's own guides, and the terminal command list. It runs only open / stop / links; a new research, a deletion, a loop or a command is a **proposal** with Confirm / Run in Terminal. Results-chat actions are proposals too. Replies written before the audit are never used as context and show "not audited".
- **Reply audit** on every chat reply (`src/chat/reply-audit.mjs`): unknown links and key values removed; unknown commands, placeholders and claimed-but-not-run actions flagged; one revision, then a visible ⚠ mark.
- **Results tab**: expected-result checks next to the memo verdict, a notice when the checks pass but the memo does not settle the question, delivered items, passing findings, still-weak pieces.
- **Files in every chat** (📎, drag and drop, paste; up to 4): photos, screenshots, PDFs and MP3/WAV read by a free vision model (Gemini via `image_url`/`input_audio`, verified live; OpenRouter `gemma-4` as fallback), text files by code. In a piece chat they become sources of that piece. Piece uploads take the same types.
- **Terminal** (`src/terminal/`): shared node-pty sessions (zsh / PowerShell / bash; piped fallback), scrollback for late joiners, WebSocket with Origin check, command buttons. `node src/frl.mjs` now does everything on macOS, Windows and Linux: start, install always-on (launchd / Windows logon task / systemd), status, url, restart, update, token, keys setup / check / list / export / import, logs. `keys.command` and `start.command` call it; `start.cmd` and `keys.cmd` added for Windows.
- Security: requests forwarded by a local proxy (Tailscale Funnel, tunnels) are no longer treated as "this computer"; `FRL_BEHIND_PROXY=1` for servers. Linux servers keep keys in systemd encrypted credentials.
- Flow fixes: researches stuck in "researching" after a crash are marked cancelled on start (4 found); restart goes through the graceful shutdown on every OS; `install` waits for launchd to unload (it failed with "Bootstrap failed: 5").
- Docs: [WINDOWS.md](WINDOWS.md), [CLOUD.md](CLOUD.md) (Oracle Always Free + Tailscale Funnel; Google e2-micro is not fully free because of the external IPv4 charge), [AUDIT-PROTOCOL.md](AUDIT-PROTOCOL.md), repo `CLAUDE.md`.

**Verified:** `npm run quality` PASSED (177 unit tests, 10 e2e on iPhone 14 and Pixel 7). Live on the running app with free models: Windows, links, ".exe + git" and cloud questions answered from the guides with the audit passed and no research created; a cloud question asked in a research chat moved to the App chat; a screenshot read by Gemini; Results chat answered from the research; terminal WebSocket refused a cross-site origin (403) and ran commands.

**Open:**
1. The two "Create a research task to compile the application…" researches are still listed: deleting them was refused by the session's permission check. Delete them in the app (open each → More → Delete this research), or ask the App chat, which now proposes a deletion you confirm.
2. The old App chat thread (with the invented links and keys) is still on disk; those replies are marked "not audited" and are never used as context.
3. A Results-chat test re-researched D2 on the cars research before results actions became proposals; it ran on free quotas.
4. Windows and the cloud steps were checked against official docs and unit tests, not on a real Windows PC or VM.

## 2026-10-18 · session 5 — redesigned UI, remote access, uploads, chat tabs

- UI rebuilt on common patterns: sidebar of researches (repeat runs grouped), centered composer, project header (status, Run, Stop, Improve, More), Outline/Map/Findings/Report/Sources tabs, inspector with docked chat; phones get a slide-in menu and a full-screen Details/Chat sheet. Playwright tests on iPhone 14 (WebKit) and Pixel 7 (Chromium) run in the quality gate.
- Remote access: `frl install` runs the app as a macOS login service; other devices need the access token (Keychain) from `frl url`; Tailscale for anywhere access. Keys move between computers as an encrypted bundle (`frl keys export` / `import`).
- Files attach to one piece as cited sources (U1, U2…); chat tabs for this piece, the whole research and the whole app (the app assistant can start researches and loops).
- First result on the cars research with the marketplace scan: 3 live, in-range kleinanzeigen listings; expected result 60% met before the loop.

## 2026-10-18 · session 4 — why there were no results, and the fix

**Diagnosis (cars DE→CZ research):** 6/21 nodes passed, 0 listing links. Causes, in order:
1. The data was unreachable: web search (LangSearch) returns reviews and catalogues, not live listings; the model's direct pages were bare homepages (mobile.de blocks readers).
2. Stop was ignored: the research run cleared the stop flag when it started.
3. Chat changes failed while the loop ran (edits refused) and the loop's revert then overwrote the chat thread.
4. The LangSearch key had been saved without its first character (fixed earlier the same day).

**Fixes:** marketplace connectors with robots.txt enforcement, schema.org extraction, ECB conversion, code-computed stats and trend snapshots; Stop checked between every step; user chat has priority (pause → apply → resume) and survives reverts; classic chat dock (messages scroll, separate input that live updates never clear); app reports posted into the chat.

## 2026-10-18 · session 3 — chat, suggestions, history, gates

**Asked:** save sessions and logs; an AI chat per node that can change the tree; researched sub-issue suggestions; re-research any piece; keep the mechanical gates; apply the newest mikoshi-construct mechanics; ship through the gates; report productivity vs paid models.

**Built:**
- Node chat (`src/research/chat.mjs`): one thread per node and one for the whole project; it can edit, add, remove, expand, suggest and re-research; it cannot write answers or grades.
- Researched suggestions (`src/research/suggest.mjs`): search first, then propose; each suggestion is graded quoted / cited / not grounded by code.
- History tab, `data/logs/*.jsonl` event, model-call and history logs, knowledge record per project (`src/logs.mjs`, `src/research/knowledge.mjs`).
- Gates: item links must appear on a fetched page; wider non-answer check; prices converted at ECB daily rates (`src/research/rates.mjs`); listing-like links ranked first; off-topic Wikipedia hits dropped.
- Self-improving loop UI (hours, start/stop, trials), expected-result field, "Build the tree first" button, deliverables table in Report.
- Ship gate: `npm run quality` (syntax, secrets, no comments, tests present, tests) and a pre-commit hook. See [PROTOCOLS.md](PROTOCOLS.md).

**mikoshi-construct 0.43.0 (latest on npm, 2026-10-09), what was taken:** a pass is reported by the gate, never by the author; secret scanning; commit guard; run ledger; the facts/claims/hypotheses knowledge record; escalate effort only when verification fails. Not taken: the full `construct init` (pnpm + TypeScript + ESLint + OpenAPI scaffolding), which does not fit a zero-dependency Node app.

## 2026-10-18 · session 2 — search, expected result, self-improving loop

- Live capability test: 7/7 marketplace pages readable (mobile.de and olx.pl only through the Jina reader); Groq, Cerebras, Pollinations answer; OpenRouter hit its 50/day cap; the saved Gemini key is invalid; no search key saved, so search was Wikipedia only.
- Added search backends LangSearch, Linkup, Jina, Firecrawl and local SearXNG (`searxng.command`), per-query rotation with 1 h benching, gap-driven re-search.
- Found: page reading dropped every link. Fixed: links kept per page; nodes can list pages to read directly.
- Added the expected-result checks and the per-project self-improving loop.
- First live loop (used cars €2,000–4,000, 10 links): score 0.144 → 0.302 in 25 min, 5 changes kept, but 0 working links, because search was Wikipedia only and guessed marketplace URLs were blocked or filtered by currency. The fixes are in session 3.

## 2026-10-17 · session 1 — the app

- Audited FREECC (tour-business calibration) → `AUDIT.md`; rebuilt as a generic research app: issue tree, free-model router with failover and cooldowns, mechanical verification, decision memo, SSE UI, CLI, templates (generic, car arbitrage, glamping, taxes, market sizing).
- Verified free providers and limits → `KEYS.md`; keys in macOS Keychain via `keys.command`.
- First live research on Groq finished; the git-level prompt self-improvement loop (`npm run autoloop`) ran until the disk filled; 2 prompt changes kept.

## Open items

1. Add Tavily as a second search key (LangSearch and Gemini work as of 2026-10-19).
2. SearXNG needs Docker Desktop restarted (it hung on 2026-10-18).
3. Many marketplaces block readers; CSV upload is the reliable path for listing data.

## Session 2026-10-23 · temp and cache rules

Asked: "clear cache and set the rules for llm research or any research to clear temp regularly".

Changed:
- `src/housekeeping.mjs` `TempSweeper`: runs on app start, then every 6 h (`FRL_SWEEP_HOURS`, `0` = off). Removes `data/work/` entries untouched 7 days, `*.tmp` under `data/` older than 1 day (not `data/llama/`), logs of deleted research untouched 7 days; trims `*.jsonl` over 5 MB to 20,000 lines and `server.out` over 1 MB to 2,000 lines. History gets one `temp sweep: …` line when something is removed.
- `EventLog.compact` trims through the append queue, so it cannot race writes.
- Test temp leaks fixed: 177 `frl-*` folders had piled up in the OS temp dir. Vitest global setup now removes the ones its run created; Playwright global setup removes earlier e2e data folders.
- Rules: PROTOCOLS.md §5b, repo CLAUDE.md, global `~/.claude/rules/research-temp.md`.
- Cleared now: `test-results/`, 177 temp folders, npm cache (`npm cache clean --force`), Homebrew cache (`brew cleanup -s`, 60.4 MB).

Open: the app on port 4600 is still the old process; it picks up the sweep at its next restart (not restarted without asking). Playwright browsers (871 MB) kept, e2e needs them.

## Session 2026-10-23 · one research on two computers

Asked: "i need to access the app and the particular research from another PC without docker just by the link to use it as a helper for the same research … commit and push merge"; then "make possible to open same research and use two machines to increase the productivity, machines have to clear yourself and dont overload the memory … commit, create an account token, merge".

Changed:
- Research share links (`src/share.mjs`, `AccessGate` share scope): More → Share this research, or `node src/frl.mjs share <id> [--off]`. The link opens one research only: its page, API and live events. Owner-only routes answer 403; the terminal WebSocket refuses share sessions; project chat questions about the app are refused instead of being forwarded to the App assistant. Tokens are HMACs of the access token, so `data/shares.json` holds no secret.
- Shared mode UI: banner, one research in the list, no New/terminal/settings/App tab.
- Memory: `ProjectStore` keeps at most 8 researches in memory (LRU, running/looping never evicted); the research list no longer loads every research into memory.
- Tests: share, auth, server (share flow over a non-loopback request), terminal socket, chat, store; e2e Share panel.
- Real use: a second instance on port 4620 with a copy of the research data, reached at the Wi-Fi address in headless Chromium: the link opened only the shared research, terminal and another research returned 403, the App tab was hidden, and a piece added on the owner screen appeared on the shared screen through the live stream. The instance and its data were deleted afterwards.

Open: compute and model quotas stay on the computer that runs the app; the second computer adds a second person working on the research, not a second quota pool.

## Session 2026-10-23 · PC could not open the link; research v2

Asked: "provide a new link, same wifi but PC has no access to the research, also, restart the app here with all new changes, proceed with self improving loop under new improved research principles … mikoshi and similar confirmation mandatory protocols".

- Mac side checked: macOS firewall disabled, app listening on all interfaces, Wi-Fi address 192.168.5.25 unchanged. The app had no record of other devices, so the cause could not be seen.
- Added `/reachable` (data-free page that tells a network problem from a link problem) and History lines for every other device that reaches the app (`src/visits.mjs`).
- App restarted on the branch code.
- The glamping research's tree failed the new structural audit (8 drivers, single-child splits) and the loop had stalled (0.366 to 0.38 over 73 trials). It was kept unchanged and its loop stopped. A v2 research with the same question, constraints and expected-result checks was built under the current principles (tree audit gate passed with 0 issues; STORM perspectives, diverse primary-first sources, chain-of-verification reply audit, gate-decided loop), then an 11 h self-improving loop starts when its first run is done.
- The old research's link was turned off; a new link opens v2.

Open: whether the PC reaches the app is unknown until it opens `/reachable`; History will show the attempt.

## Session 2026-10-23 · lanes and teammates, grounded checks, product review

Asked: make the Mac and the PC work as one team so the loop is faster; then "results in listing dont have to mention glamping … find the root cause … fix, merge, restart on both machines keeping the results"; then "review the entire logic … fix the flaws, produce the report with suggestions, clear inappropriate and useless processes".

- Lanes for runs and loop trials, teammates join as lanes; grounded criteria with re-grounding of stored checks; verified pieces that cannot gain are no longer loop targets; router keeps credit/key/daily benches across restarts; review skipped on answers already failing; list summaries cached; favicon no longer logged as a refused device; `data/market/` removed.
- Live: the old glamping research enforces 50 items and €0–20,000 only (re-scored to 0.398), and its loop resumed after the restart; the PC started a 24 h loop on v2 at 10:18, and v2's checks were re-grounded too.
- Report: [REVIEW-2026-10-23.md](REVIEW-2026-10-23.md).

Open: the PR still needs a merge by the user (the merge command was refused by the permission check); two loops share the same free quotas; data deletions listed in the report need the user's yes.

## Session 2026-10-23 · one research, one loop, one team

Asked: keep all insights and progress, restart with the improvements and the loop, one link, the PC working in the same team, "no different versions", push, merge, restart, instructions for the other machine.

- One research kept as the current one: `find-appropriate-plots-to-buy-fo-b7772e` (21/25 pieces passing, best 0.409, 90 trials). v2 (`…3ed9dc`, 13/25, best 0.211) was stopped with a handoff and its link turned off; its data is kept.
- Gemini quota window: the provider now appends `[quota window: per minute|per day]` or the `retryDelay` from the full error body, so a per-minute 429 is no longer benched until midnight; benches restored at start ignore the ambiguous "exceeded your current quota" alone.
- App restarted on the current code with the one loop.

## Session 2026-10-23 · llama.cpp on both machines, models, no-stop loop

Asked: install llama (why it did not work), let it work on both machines; make models, research, loop, the PC link, llama and Ollama work; a real link for the next PC that uses its own llama; the loop must run with no stops and memory must be cleaned regularly.

- Why llama did not work: llama.cpp was installed on 2026-10-19 but never started (no model, no server); after starting, its 4,096-token slots were smaller than the app's 7–8k-token prompts. Now: Qwen3-4B on this Mac, 16,384 tokens per request, q8_0 KV cache, background, restarted with the app (`data/llama/serve.json`); the router never sends a local server a prompt bigger than its context (`/props`).
- Models: per-model daily limits (Gemini PerModel, Groq "limit reached for model … per day", Cerebras "per day limit exceeded") switch to the next model instead of benching the provider; Gemini and Groq preferences list the models these keys have today. Live: Gemini moved 3.8 → 3.7 → 3.6-flash, Cerebras to qwen-3.8-27b.
- Other PC: one PowerShell line from the share panel (`/pc-setup.ps1`) installs llama.cpp and a model by graphics memory; `PeerWatcher` connects it within a minute of the PC opening the link; `node src/frl.mjs local pc <address>` does it by hand. Ollama on the PC works the same way through `OLLAMA_BASE_URL` (port 11434, `OLLAMA_HOST=0.0.0.0:11434`). Not run on the PC itself: it was not reachable from this Mac (no answer on 8090/11434).
- No stops: loop resume checkpoints after every pass (crash or power cut resumes); always-on service relaunches the app; every in-memory list is capped; disk temp is swept every 6 h.
- Ollama is not run on this Mac on purpose: with 8 GB and llama.cpp loaded, free memory was 14%.

## Session 2026-10-23 · research page UX

Asked: components collide, design inconsistent, no loop indicator, no remaining hours, research and piece conversations not thought through.

- Loop status bar under the header whenever the loop or a run works: time left and end time, lanes, kept of tried, score baseline → best, last trial with plain-language outcome; refreshed every 30 s. Run status bar shows pieces done and lanes.
- Header: question clamped to 2 lines (click to expand); Stop says "Stop loop" / "Stop run"; the Improve loop menu hides while the loop runs; Join tooltip shortened.
- Side panel: Piece details | Chat tabs on every screen size, so one area scrolls at a time (the stacked, partly scrolled details block was the overlap in the screenshot).
- Chat: one-line "Talking about: …" context; app reports grouped into one collapsible "N app updates" row and each one collapsible; how-to hint shown until the first message; request first, "Done when" under it; the stray "loop running" label removed.
- Tree bar: the duplicate "Improve whole research…" removed; "Improve selected…" appears only when pieces are ticked; Q's grade uses the same badge as other pieces.
- Checked at 1440×900 and 390×844: no sideways scroll, no script errors; e2e asserts the loop bar and the Stop label.

## Session 2026-10-23 · investment logic, hints, contextual chat examples

Asked: why the piece chat talks about a kiosk in Brno; e-bike lanes are not required; affordable land includes land that needs work, and that is the investment logic, not a hint; merge and run everything; continue the research with a desktop-friendly UI.

- The Brno kiosk was a fixed example in the chat hint; examples are now built from the selected piece or the weakest piece.
- Glamping template: cheap raw land that needs work is in scope; site preparation (clearing, levelling or terracing, access, water, power, drainage) is its own driver; plots are judged by all-in cost (purchase + preparation) and suitability after the work.
- Research hints: a per-research soft-guidance field sent to every prompt, editable in the header while it runs.
- The live research's tree is updated accordingly (see the next entry in the log of the research itself).

## Session 2026-10-23 · productivity of the loop and router

Asked: research how to make the engine produce valid results faster, apply only changes that surely help, and keep them for later researches.

- Measured (since lanes, 2.8 h): 55 trials, 5 kept (1.8/h); 25 undone after a full re-roll; 3 pieces took 25 trials with 0 kept; reviews 164 of ~250 model-minutes, mostly Pollinations (51 s) and the 1-slot local llama.cpp (402 s average, queueing).
- Shipped: `no-gain` early exit (exact: such a trial cannot raise the score), 6 h rest for pieces with 3 futile trials, slot-aware routing for local servers, slow-provider demotion. Rules and evidence: PROTOCOLS.md §4h.
- Measured 31 min after the change (window computed in UTC; a first comparison that read the start time as local time was wrong and is discarded): trials/h 18.8 → 22.9, median review 15.2 s → 9.4 s; kept/h 1.45 → 1.91 on a single keep, too few to call. Reviews over 60 s were still 16 of 54: the other PC's llama.cpp (Qwen3-4B, 1 slot) timed out on all 12 and SambaNova on 7. Added: 2 timeouts in a row bench a provider for 10 min, and timeouts count as slow calls.

## Session 2026-10-23 · Join cannot be double-clicked

Asked: an accidental double click on Join added two lanes; remove one and make it hard to misclick.

- One lane per browser: Join carries a per-browser id, so a second click on the same browser changes nothing; once joined the button reads "✓ Joined · Leave (N lanes)" and asks before giving the lane back (`POST /api/projects/<id>/leave`); every click locks the button for 2 s. The extra lane was removed by the restart (lanes are kept in memory).

## Session 2026-10-23 · lanes explained; idle components fixed

Asked: why 3 lanes for 2 machines, and what can be improved for each component that is not engaged.

- Lanes are parallel trials run by the app on the Mac (2 by default, +1 per joined browser), not machines; the loop bar now says so on hover and shows how many are joined.
- Other PC's llama.cpp: measured 12 tok/s reading, 2.1 writing (CPU, no usable graphics card found): 774 s per typical call, 19/19 failed today. Now measured on connect and every 30 min and kept out of research as "too slow"; the PC setup script lists the devices llama.cpp can use and warns when there is no graphics card.
- Ollama on this Mac: running, but saved as `http://localhost:11434/` (no `/v1`, so every call was a 404) and no model pulled. Local addresses now get `/v1`; the status says `ollama pull qwen3:4b`. No model was pulled: with llama.cpp loaded only 14% of the 8 GB was free.
- Not configured (need the user's free sign-up): Mistral, NVIDIA, Cloudflare, Cohere, Puter — steps under Models & router → How to get it. SambaNova has no credit. Cerebras and OpenRouter reset at 00:00 UTC.

## Session 2026-10-23 · tree and research logic review

Asked: review how the tree is formed and the research logic against real research techniques; fix, merge, restart both machines.

- Found in the live research: 18 top-level drivers (max 7) grown by loop trials, D6–D18 mostly the same "find affordable coastal plots" question, titles "D9"/"A"/"B"/"C", listing pieces answering "none found" graded verified, and criteria answered as averages so no plot was ever screened.
- Fixed: structural gate on loop trials, driver cap, duplicate drivers moved under the first one (findings kept), placeholder titles named from the question, listing pieces must deliver listings, funnel tree for list results and item screening in the memo (PROTOCOLS.md §4i, CONCEPT.md).

## Session 2026-10-24 · why it failed

Asked: why failed; fix, merge.

- The loop stopped at 2026-10-23 21:12 UTC. Cause chain: the app ran out of memory (2 GB heap) at 21:05 because live updates buffered the whole research for pages whose connections had silently died; the always-on service restarted it; the loop's start-up re-roll then failed on every provider (Gemini 503, Groq 413) and that error ended the loop.
- Fixed: bounded, batched live-update stream (`src/events.mjs`); loop pauses 5 min on provider outages instead of ending; graceful restart at 1.5 GB heap (`src/heapguard.mjs`).
- GitHub CI failed twice on the same flaky e2e test (router page: click while the phone sidebar was still sliding in, 60 s limit); the test now waits for the sidebar and has 2 min.
- CI then failed on Node 22 in another phone-menu e2e test (same cause: clicking inside the sliding sidebar). The app now drops animations under prefers-reduced-motion, and the e2e runs with reduced motion and waits for the menu to open.

## Session 2026-10-24 · memory precautions, local models by speed

- Research file 3.3 MB, 2.4 MB of it page text and link lists: stored sources now capped (4,000 chars, 40 links) after a piece is researched, pages get a light view. Graceful restart at 1 GB heap; memory sampled every 10 min to data/logs/memory.jsonl with the count of open live-update connections.
- Local models routed by measured speed per call: first when the call fits (this Mac: rollups and short calls), last resort otherwise with a time limit sized to the estimate (a long memo on this Mac gets ~4 min instead of failing at 120 s); the other PC stays unused while it is CPU-only.
- First live check marked this Mac's llama.cpp "too slow" (reads 0 tokens/s): llama.cpp's prompt cache served the repeated test prompt. The test now sends a unique prompt with cache_prompt false and ignores timings over fewer than 200 prompt tokens. Sources are also compacted when the loop starts. A server test's 12 s wait was too short under full-suite load; it now waits up to 45 s.

## Session 2026-10-24 · no substantial results; memory cleanup

Asked: there are no substantial results; clean memory where it is not needed.

- Memory: this Mac's llama.cpp used 9.3 GB (llama.cpp's RAM prompt cache, default 8 GB) and pushed 14 GB into swap; restarting it then failed with a GPU out-of-memory error. It is stopped and its autostart removed (swap 14.1 → 4.6 GB, free 65%). New llama.cpp starts use `--cache-ram 0` and `--sleep-idle-seconds 300`; the speed check does not wake a sleeping server. Re-enable with `node src/frl.mjs local start --model ggml-org/Qwen3-4B-GGUF:Q4_K_M --ctx 16384 --parallel 1 --kv q8_0 --background`.
- Results: of 35 delivered items, junk counted toward "at least 50 items" (70%): a cemetery plot, search/news pages, plots at $90k/€400k. Now only valid items count (single listing page that opens, price in range); the loop re-measures before its baseline.
- CI: one unit test failed on Node 22 without a name in the gate output; the gate now prints failing test names for unit and e2e failures.

## Session 2026-10-24 · confirmation gates and a reworked approach

Asked: recheck how mikoshi-construct is applied and the confirmation gates, so junk is never collected and failures are not produced; take precautions; rework the approach.

- Self-audit against the construct: changes that act on live data shipped with unit tests only (D5 renamed by the candidates repair; the speed check fooled by llama.cpp's prompt cache); pushes went straight to main so CI ran after merge; a UTC/local mix-up in a measurement; items were counted, not screened.
- App: item gate on every listing (single listing page, item kind, price range after conversion), rejected items kept with reasons, existing listings re-screened at loop start. Witness on the glamping research: 30 of 37 removed (grave, search/news/filter/home pages, houses, $90k–€600k plots), 7 real land listings kept.
- Process: `node scripts/dryrun.mjs <id>` (read-only witness), `flakes` gate (changed tests 3×), gate names failing tests, pre-push hook refuses direct pushes to main, AUDIT-PROTOCOL S7 (witness), S8 (measurements), O2b (PR + CI before merge). The intermittent server test was a race with the run's final teammate reset; the test now waits for the run to stop.

## Session 2026-10-24 · verified quotes, then why the merge test failed

Asked: every claim backed by a verified quote, answers grounded in claims, reasoning shown; then "why doesn't it work — continue, revise and fix the merge test".

- PR #5: each claim carries a verbatim quote that code finds in the cited source (`src/research/attribution.mjs`, GopherCite/ALCE pattern); the answer may state only numbers from its claims or calculation (`grounded` check); findings show the model's reasoning. Old findings are not re-graded by this (no quotes stored); the dry run on the glamping research reports 0 grade changes.
- Witness with real free models on a copy of the glamping research (nothing saved), 2026-10-24 between 10:15Z and 11:20Z, 5 pieces: Gemini D4.1 verified, 3 of 3 factual claims quoted and found. Pollinations D2.1, D5.1, D1.1.2 weak: bad search sources (a desert-climate page for a glamping-season question) and an invented "20 km" that the `grounded` check caught. Raw Pollinations reply does carry quotes. Gemini hit its daily quota (HTTP 429) during the witness; Cerebras, SambaNova and OpenRouter had no calls in the recent ledger. Too few samples to rate quote pass rates per provider.
- Gap fixed: an answer with no claims skipped the attribution check and could be graded supported; it now fails attribution ("the answer has no claims behind it").
- Merge test: `tests/server.test.ts` "one more lane" failed 1 of 7 full runs. Cause in `ResearchEngine.run`: a finished run cleared its running flag, then awaited the handoff, then in `finally` removed all teammates and cleared the running flag again, wiping a teammate (or a new run's flag) that arrived in between. The flag and the lanes are now released together, once.
- Open: the live app (started 07:29Z, PR #4) runs without PR #5 until it is merged and the service restarts; search quality on listing pieces (irrelevant sources) is the main reason pieces stay weak.
