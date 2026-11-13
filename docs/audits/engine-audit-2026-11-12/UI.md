**The report is not saved to `data/audit/UI.md`: file writes in this session were not approved (both the report and the scratch scripts were refused), so the full report is below instead.** Approve the write, or paste this into the file.

# UI audit 2026-11-12: user interface and API

Scope: `public/index.html`, `src/server.mjs`, `src/app.mjs` `status()`, `src/appchat.mjs`, `src/research/chat.mjs`, `src/workbook.mjs`, `src/share.mjs`, `src/auth.mjs`.

How it was checked: every file in scope was read in full. "Verified by running" means one of two things:
- a read-only `node --input-type=module -e` one-off against `data/projects/*.json` through the real `withResults()` (what the API sends to the page);
- the same kind of one-off against `createServer()` with an in-memory stub app on 127.0.0.1.

No scratch file was written, and nothing was run in a browser.

### UI-1. The Results headline counts plots the verifier has not confirmed (A1 is back)
- class: definite bug
- severity: high
- where: `public/index.html:1488-1489` (`proposalsHtml`), `:1443` and `:1457` (`candidatesHtml`), `src/workbook.mjs:193-194` (`summaryRows`)
- evidence: verified by running on b7772e. The headline is built from the proposal section, not from the counted rows:
  `const fits=(pr.sections.find(x=>x.id==="fits")||{urls:[]}).urls.length;` … `fits+" result(s) fit every criterion"`.
  Observed on the real research:
  - proposal `fits` section: 273 URLs, of which 266 are confirmed and 7 unconfirmed; its own text says "these count toward your result".
  - `candidates.keptCount` is 266, and `countsTowardResult` is true for 266 rows.
  - `candidates.verification`: 332 confirmed, 496 refuted, 54 unconfirmed (the 332 are 266 fits + 14 trade-offs + 52 "to confirm").

  So one Results screen states "273 result(s) fit every criterion" (headline), "266 fit every criterion" (candidate table line), "Fits 273" (tier button) and "332 confirmed … only confirmed plots count" (verifier line). Expected per A1: the headline is fits ∧ confirmed = 266. The concept audit does not catch it: C1 passes on this research.
- impact: the first number the user reads overstates the result by 7 plots that no outside check confirmed, and three different totals sit next to each other. The workbook Summary sheet lists 273 fits and 332 confirmed and has no row for the 266 that count.
- fix: use `p.candidates.keptCount` for the headline and show "273 fit, 266 confirmed outside the app"; label the verifier line "332 confirmed (266 of them fit every check)"; add a `counted toward the result` row to `summaryRows`.
- test: `tests/workbook.test.ts` "summary states the counted number": with b7772e, `summaryRows` contains `['counted toward the result', 266]`. Plus an e2e check that `#proposals .verdict` starts with `candidates.keptCount`.
- confidence: 0.9

### UI-2. Any web page open on the same computer can drive the app's API (no Origin or Host check on loopback)
- class: definite bug (security)
- severity: high
- where: `src/auth.mjs:38-40,53` (`isLoopback` → `{ allowed: true }`), `src/server.mjs:56-70` (`readJson` parses any content type), `src/server.mjs:394-452` (no Origin or Host check; only the terminal WebSocket has one, `src/terminal/socket.mjs:6`)
- evidence: verified by running against `createServer(stubApp, new AccessGate())` on 127.0.0.1, sending `Origin: https://evil.example`, a foreign `Host`, and `content-type: text/plain` (a "simple" request a browser sends cross-site without a preflight):
  ```
  POST /api/terminal                -> 200   handler called: terminal.create({"cols":80})
  POST /api/keys                    -> 200   handler called: setKey("custom","k","https://evil.example/v1")
  POST /api/projects/…b7772e/reset  -> 200   handler called: resetResearch(id,{"tree":true})
  GET  /api/status (foreign Host)   -> 200
  ```
  Expected: 403 for a cross-origin write and for a Host that is not this app.
- impact: a page the user visits while the app runs can:
  - point the "custom" provider at an attacker's server, so every research prompt goes there and its answers come back as model output;
  - wipe a research's tree, start loops that burn the free quotas, or restart the app;
  - with DNS rebinding (the foreign Host is accepted), read every research and `/api/access`, which returns the token link when remote access is on.
- fix: before routing, reject when `Origin` is present and its host differs from `Host`; for loopback requests accept only `Host` of `127.0.0.1`, `localhost` or `[::1]` with the app's port; require `content-type: application/json` on POST, PATCH and DELETE.
- test: `tests/server.test.ts` "refuses cross-site writes": `POST /api/keys` with `origin: https://evil.example` and `content-type: text/plain` returns 403 and `app.setKey` is not called; `GET /api/status` with `host: attacker.example` returns 403.
- confidence: 0.9

### UI-3. A stale "loop active" flag locks the page in "improving", and "Join" starts a full run
- class: definite bug
- severity: high
- where: `public/index.html:604` (`isLooping`), `:868`, `:871-872` (`renderHead`), `:930` (`renderLoopBox`); `src/research/blockers.mjs:76`; `src/research/improve.mjs:517`; `src/watchdog.mjs:7`; `src/server.mjs:221-228`
- evidence: verified by running on 0c750f. The stored project has `improve.active: true` and `deadline: 2026-11-04T11:14:19.686Z`, and at the same time `stopReason: "stopped by user"`, `finishedAt: 2026-11-04T00:12:50.617Z`, `phase: done`. No loop runs. The page decides with
  `function isLooping(p){return !!p&&((STATE.status&&(STATE.status.improving||[]).includes(p.id))||!!(p.improve&&p.improve.active));}`
  so the stored flag alone makes it "looping". Observed from `withResults`: the "What these results are" card says "The self-improving loop is running until 2026-11-04 11:14Z, so numbers can still move" (as of 2026-11-12). By reading the rest:
  - the header shows "improving", the Run button reads "⚡ Join", and `$("btnLoop").parentElement.style.display=looping?"none":""` hides the Improve loop menu; the loop box shows "until 11:14" and no Start button.
  - "⚡ Join" posts `/run`; the server finds no loop and no run and calls `app.engine.start(id)`, a full research run.
  - "■ Stop loop" posts `/improve/stop`, which returns `{ ok: false }` and leaves the flag set.
  - `crashedLoop` returns null when `improve.active` is true, so the watchdog never revives or settles it; `settleStale` (`src/app.mjs:515`) only repairs `phase`.
- impact: the user's car research looks busy eight days after it stopped, cannot be put into a loop from the page, and a click on "Join" spends quota on a run nobody asked for.
- fix: in `settleStale`, set `improve.active=false` with `stopReason: 'app stopped'` for every project the improver does not hold; make `isLooping` trust only `STATE.status.improving` once status has loaded; clear `finishedAt` and `stopReason` in the start record at `improve.mjs:517`.
- test: `tests/app.test.ts` "settleStale clears a loop flag nobody holds": save a project with `improve: { active: true, deadline: '2026-11-04T11:14:19.686Z' }`, call `settleStale()`, expect `improve.active === false` and no "loop is running" line from `resultsNature`.
- confidence: 0.85

### UI-4. The implementer you click for an app change is thrown away by the server
- class: definite bug
- severity: medium
- where: `src/server.mjs:255-258`; `public/index.html:1196-1197` (`decide`), `:1168-1169`; `src/appchat.mjs:198,208-211,187`
- evidence: verified by running. The page sends `{at,pid,accept,engine}`; the route passes only `accept`:
  `return app.appChat.decide(String(body.at ?? ''), String(body.pid ?? ''), { accept: body.accept !== false });`
  Stub run: `POST /api/chat/decide {"at":"2026-11-12T10:00:00.000Z","pid":"p1","accept":true,"engine":"free"}` → the handler received `{"accept":true}`. `AppChat.decide` accepts `engine` and would store it. Without it, `runProposal` uses `engineOf(p.engine)`: the engine the model proposed, or `free` when it proposed none.
- impact: "Implement with Claude Code", the primary button, runs the free coder unless the model happened to propose `claude`. When the model did propose `claude`, "with free models" starts Claude Code and spends the user's Claude plan against an explicit choice (CONCEPT: "you then choose Claude Code or the free models").
- fix: pass `engine: body.engine ?? null` in the route.
- test: `tests/server.test.ts` "decide passes the chosen implementer": post a change-proposal decision with `engine: 'claude'` and expect the proposal's stored `engine` to be `claude` (or the "not installed" error), never a ticket with `engine: 'free'`.
- confidence: 0.9

### UI-5. "2546 to check" opens a list of 104, and the rest cannot be seen or exported
- class: ui
- severity: medium
- where: `src/research/candidates.mjs:19,283` (`MAX_TO_CHECK = 100`, `toCheck.slice(0, MAX_TO_CHECK)`); `public/index.html:1443,1477`; `src/workbook.mjs:96` (`plotRows`)
- evidence: verified by running. 0c750f: `toCheckCount` 2546, `toCheck.length` 104. b7772e: 218 and 100. The page writes
  `c.toCheckCount+" pass every limit that the listing shows, but miss a price or a country"` and then renders `c.toCheck.map(oldRow)` with no "first 100" note. The workbook's Listings sheet reads the same capped array.
- impact: in the car research 78% of everything found (2546 of 3257) is "to check"; the user sees 104 of them and cannot get the other 2442 in the page or in any export. On b7772e the count line also does not add up: 266 + 160 + 449 + 113 + 5 + 218 + 1279 = 2490 of "2950 found", and nothing says where the other 460 are. The cut itself is already known; the missing label is not.
- fix: store all to-check rows (or at least URL, title and reason) and page them in the UI; until then write "showing the first 104 of 2546" and add "N not shown (table limit)" to the count line.
- test: `tests/workbook.test.ts` "Listings sheet holds every to-check row": for 0c750f, the rows with `list === 'to check (price or country not shown)'` number `candidates.toCheckCount`.
- confidence: 0.85

### UI-6. Every live update sends and redraws the whole research: 6.4 MB per push on the plots research
- class: design flaw
- severity: medium
- where: `src/server.mjs:376` (`render: (current) => ({ ...withResults(current), ...teamOf(id) })`), `src/events.mjs` (`PUSH_EVERY_MS = 500`), `public/index.html:842,845` (`renderAll` on every message), `:881` + `:933-938` (`renderHead` → `renderLoopBox` → `loadCrossPrinciples`), `:1647`
- evidence: payload verified by running: `JSON.stringify(withResults(project)).length` is 6,423,191 bytes for b7772e (5.36 MB is `candidates.kept`), 1.33 MB for 0c750f, 1.44 MB for b2f5b7. The rest by reading:
  - the stream pushes that payload after any engine event, at most every 500 ms, uncompressed, to every open tab.
  - the page parses it and runs `renderAll()`, which rebuilds the 1000-row table with `box.innerHTML=h`.
  - that rebuild closes every `<details>` the user opened (to-check list, screened-out examples, strategy sources) and resets the table's sideways scroll; only the inspector keeps its state (`:1113`).
  - every `renderHead` calls `renderLoopBox`, which calls `loadCrossPrinciples`: one `GET /api/principles?project=…` per live update and per 8-second poll, per tab.
- impact: during a run or a loop the Results tab cannot be read (lists snap shut up to twice a second). A phone on mobile data downloads the full research again and again (CONCEPT: "open it from any device"). A client slower than about 0.85 Mbit/s is dropped after 60 s (`STUCK_MS`) and reconnects in a cycle.
- fix: send the full project only on `hello` and when `candidates.builtAt` changes, otherwise the event plus the changed nodes; in `renderResults` skip the rebuild when candidates and report are unchanged, and keep open `<details>` by id; load the principles once per project.
- test: `tests/events.test.ts` "a node event does not resend the candidate table": push a `node` event for b7772e and expect the payload to be under 200 kB.
- confidence: 0.8

### UI-7. "Reposts" merges different plots, and the sidebar hides researches with the same question
- class: likely bug
- severity: medium
- where: `public/index.html:1417-1418` (`repostKey`, `groupReposts`), `:1460`; `:815-819` (`groupProjects`), `:829`, `:1736`
- evidence: reposts verified by running a copy of `repostKey` on b7772e's 1000 kept rows. The key is price | rounded area | place | country:
  - 21 rows are hidden in 21 groups.
  - in 5 groups the members have different coordinates, in 13 different titles, in 3 different tiers.
  - 4 hidden rows count toward the result, so the "Fits 273" button lists 269 rows.
  - one group joins `…/terreno-bombarral-ID1jc4M` (fits, confirmed, 39.41 N) with `…/hpr/pt/anuncio/terreno-4-quartos-34-m2-remodelado-ID9P5lli` (to confirm, refuted, 41.59 N); two Válega plots about 250 m apart with different listing ids are merged as well.

  Sidebar, by reading: `groupProjects` keys on the lower-cased question and `renderProjectList` draws only `g.latest`; History shows "N runs" but the row opens the latest one only.
- impact: counted plots are missing from the table the user reads (they are still in the export), and a refuted row can hide behind a confirmed one. An earlier research with the same question cannot be opened from the page (the E8 situation: two researches for one question).
- fix: group only rows whose coordinates agree within 50 m (or whose URL listing id is equal), and make the "+N reposts" badge expand the hidden rows; in the sidebar show a "N runs" row that expands to all of them.
- test: a unit test on an extracted `groupReposts`: the two Válega rows (`…ID1iWkt`, `…ID1ixnA`) stay two rows; two rows with equal coordinates collapse to one.
- confidence: 0.75

### UI-8. One table for every kind: the car list shows ten empty plot columns and a plot-only details panel
- class: ui
- severity: medium
- where: `public/index.html:1392-1412` (`CAND_COLS`), `:1415` (`colsFor` drops only the sea column), `:1452` (`row`), `:1505-1528` (`renderPip`)
- evidence: verified by running.
  - 0c750f: 205 kept rows, 0 with `plan`, 0 with `site`. So Opportunity · rank, Tier, Checks met, Entry, Area m², Units, Months, Hottest °C, Explore and Real trend % show "–" in every row. The last column, headed "Proposal · click a row for the full reasoning", is "–" too.
  - b7772e: 0 of 1000 rows have `marketValue`, `valueCase`, `valueIndex` or `year`, so Market value, Why it stands out, Resale potential, Value vs peers and Year · km are empty.
  - By reading: a click on a car row opens the panel with tier "–", price and place only. Year, mileage, the value case, the 80% interval and the comparables the engine computed are not in it.
  - The workbook already drops empty columns (`src/workbook.mjs:152`); the page does not.
- impact: the car user scrolls a 19-column table that is half empty, and the "full reasoning" the header promises does not exist for cars: the reasons are reachable only as hover text.
- fix: build the column list the way the workbook does (keep a column only when some row has a value) and give `renderPip` a branch for rows without `plan` that lists `valueCase`, `marketRange`, `valueNotes`, year and km.
- test: e2e "car table has no plot columns": open 0c750f, expect no `th[data-csort="units"]` and a details panel that contains the row's `valueCase.reasons[0]`.
- confidence: 0.85

### UI-9. A share link can wipe the research, although the dialog says guests "run it and add pieces"
- class: design flaw (security)
- severity: medium
- where: `src/share.mjs:7,17-24` (`shareAllows`); `public/index.html:970`; `src/server.mjs:96-98` (`sharedStatus`), `:229-232`
- evidence: verified by running `shareAllows` for a guest of b7772e:

  | Request | Result |
  |---|---|
  | `POST …/reset` | allowed |
  | `PATCH /api/projects/:id` | allowed |
  | `DELETE …/nodes/D1` | allowed |
  | `POST …/improve` | allowed |
  | `GET …/snapshots` | 403 |
  | `POST …/restore` | 403 |
  | `DELETE /api/projects/:id` | 403 |
  | `GET /api/principles` | 403 |

  Only three sub-paths are owner-only: `new Set(['/share', '/snapshots', '/restore'])`.
- impact: anyone holding the link can clear all findings or delete the tree (`reset` with `tree: true`), change the expected result, remove pieces and start loops on the owner's quotas, while only the owner can restore. The guest's Loop tab shows "Failed to load: this link opens one research only", because the principles call is refused. `sharedStatus` still sends provider names, states and which search keys are set, which the dialog calls "settings" guests cannot see.
- fix: make `/reset` and `PATCH /api/projects/:id` with `expected` or `acceptance` owner-only; allow `GET /api/principles?project=<own id>`; reduce `providers` in `sharedStatus` to a ready count.
- test: `tests/share.test.ts` "a guest cannot reset": `shareAllows({ method: 'POST', pathname: '/api/projects/x/reset', projectId: 'x' })` is false; `GET /api/principles` with `project=x` is allowed.
- confidence: 0.8

### UI-10. Times are shown in UTC in some places and local time in others, without a mark
- class: ui
- severity: low
- where: `public/index.html:930` (`i.deadline.slice(11,16)`), `:907` (`toLocaleString`), `:826` (local), `:1179`, `:1152`, `:1626`, `:1733`, `:1355`, `:1381`, `:1739`, `:971` (all UTC slices, no "Z")
- evidence: verified by running with 0c750f's deadline `2026-11-04T11:14:19.686Z`: the loop box prints "until 11:14"; the status bar, for a browser in Europe/Prague, prints "ends Wed 12:14". Chat times, "the memo was written at", History, timelines and "on since" are UTC without a label; the sidebar dates are local. Only the verifier and sweep lines carry "Z".
- impact: the same loop end is shown an hour apart on one screen, and chat and log times look an hour (in summer two) off to a user in Czechia.
- fix: one helper `hhmm(iso)` that formats in local time everywhere, with the full UTC stamp as the tooltip.
- test: e2e with `timezoneId: 'Europe/Prague'`: the loop pill and the loop box show the same end time for one deadline.
- confidence: 0.9

### UI-11. "The question itself is not settled yet" is shown even when the memo says GO
- class: definite bug
- severity: low
- where: `public/index.html:1636`
- evidence: verified on 0c750f. The condition is `ar.score>=0.99&&!/^\s*GO\b/i.test(r.verdict)`. The stored verdict is "PROVISIONAL (low confidence; 6 pieces to fix, research or clarify) — Table (computed by code): 205 results kept — … — model memo: GO · …" and the score is 1. Code prefixes every verdict with "PROVISIONAL (…)" or the table count, so the test can never see a leading "GO"; the notice appears on every research that meets its expected result.
- impact: a standing warning that carries no information, printed with the first 80 characters of the verdict in bold.
- fix: test `r.modelVerdict` (it is in the report) instead of `r.verdict`.
- test: e2e: on 0c750f the notice is absent; on a research whose `modelVerdict` is "NO-GO" with a full score it is present.
- confidence: 0.85

### UI-12. "Delivered (3)" lists items that failed the checks exactly like the one that passed
- class: ui
- severity: low
- where: `public/index.html:1641`; `src/workbook.mjs:251-254` (`itemRows`)
- evidence: verified on b2f5b7. `acceptanceResult.items` holds 3 items; the check says "1 of 3 delivered pass every check" and the concept audit says "1 of 20 item(s) delivered". zagumi.com and wiltex.eu have `purpose: [{ passed: false }]`; usfripe.com has `listing: false`. The table prints only `live`, `inRange` and `region`, so all three rows read "open · live" in green under the heading "Delivered (3)". The workbook's Delivered items sheet has no column for `listing` or `purpose` either.
- impact: the user takes three suppliers as delivered where the app's own check accepts one.
- fix: add a "passes every check" column (and the failing check's name) from `listing`, `purpose`, `mentions` and `inRange`; head the card "Delivered: 1 valid of 3 inspected".
- test: `tests/workbook.test.ts` "item rows say which item is valid": for b2f5b7 exactly one row has `valid === 'yes'`.
- confidence: 0.8

### UI-13. Status codes: internal errors answer 400 with the raw message, unknown ids answer 200
- class: likely bug
- severity: low
- where: `src/server.mjs:88-94` (`statusFor` ends with `return 400`), `:104-110` (`deny`), `:247`, `:299`, `:119`
- evidence: verified by running on the stub: an engine that throws `TypeError('Cannot read properties of undefined (internal bug)')` gives `400 {"error":"Cannot read properties of undefined (internal bug)"}`. By reading:
  - `GET /api/projects/<unknown>/logs`, `/handoff` and `/share` return 200 without checking that the research exists.
  - `deny` answers API calls with a 401 HTML page, which `api()` (`public/index.html:599-600`) turns into the toast "HTTP 401" with none of the reason text.
- impact: a server fault looks like a user mistake and leaks an internal message; a guest whose link was turned off sees "HTTP 401" and a live stream that silently retries.
- fix: return 500 with a generic message for errors that are not `HttpError`, `NotFoundError`, busy or validation errors (and log the stack); return JSON `{ error: reason }` from `deny` when the path starts with `/api/`; load the project in the three routes.
- test: `tests/server.test.ts` "an internal error is a 500": stub `engine.load` to throw a `TypeError`, expect 500 and no "Cannot read" in the body.
- confidence: 0.8

### UI-14. Escaping: no exploitable injection found, three weak spots remain
- class: uncertainty (security)
- severity: low
- where: `public/index.html:588` (`esc`), `:1459`, `:1628`, `:691`
- evidence: by reading every `innerHTML` in the file. `esc` escapes `& < > "` but not `'`. The weak spots:
  - the country filter button is written without `esc`: `'">'+(x==="all"?"All":x)+"</button>"`.
  - the action impact is written without `esc`: `'<td class="small">'+a.impact+"/5</td>"`.
  - one attribute is single-quoted: `"<a href='"+esc(p.signup)+"'"`.

  Verified on the data that today these are safe: country is a name from the app's own country list (`candidates.mjs:195`; observed values Czechia, Poland, Germany, Portugal, Spain, Turkey, Vietnam, Malta) and every `impact` is a number. Everything scraped (titles, places, quotes, model text) goes through `esc`, links through `safeUrl`, and CSV cells through `csvSafe`.
- impact: none today. The first change that lets a scraped string into `country` (the fallback at `candidates.mjs:195` already passes an unknown code through) becomes stored script in the owner's page, which has the terminal.
- fix: add `.replace(/'/g,"&#39;")` to `esc`, wrap the two values in `esc()`, and add a `Content-Security-Policy` without inline event handlers.
- test: e2e "a hostile country name is text": a kept row with `country: '<img src=x onerror=alert(1)>'` renders no `img` element in `#candidateTable`.
- confidence: 0.7

Summary
- Counts per class: definite bug 5 (UI-1, 2, 3, 4, 11) · likely bug 2 (UI-7, 13) · design flaw 2 (UI-6, 9) · ui 4 (UI-5, 8, 10, 12) · uncertainty 1 (UI-14). Part 4 row that no longer holds: A1 (C1 passes while the headline says 273 against 266 counted).
- Most damaging: UI-1 for the result (the headline counts 7 unconfirmed plots as fitting, and three different totals share one screen); UI-2 is the worst for safety (any web page can rewrite keys or wipe a research through the loopback API).
- Not checked: nothing was rendered in a browser, so layout, the phone bottom sheet and the terminal WebSocket were read, not exercised; the stub-server runs prove routing and auth, not the real `App`; neither the report file nor any scratch script could be saved.