# Startup out-of-memory audit — 2026-11-12

# Startup out-of-memory audit — 2026-11-12

Read-only investigation of `~/free-research-llm/data/logs/server.out` (1,892 lines, mtime 2026-11-12T19:07:32Z ≈ 20:07 local, i.e. the log ends at the ~20:05 local restart). No writes under `data/`, no POSTs, no restarts. `server.out` lines carry no timestamps; times below are derived from `data/logs/history.jsonl` app start/stop events plus the process uptimes in the crash headers. Worktree `work/oom` HEAD == `main` == be8649e.

## 1. Every failed start (11 total)

### 1a. OOM crash A — pid 78426, lines 597–658
- Started by: the always-on supervisor (launchd/systemd unit with `FRL_SUPERVISED=1`, `src/service.mjs:10,77`) respawning `node src/server.mjs` after an in-app restart (`node src/frl.mjs restart` → POST /api/app/restart, `src/server.mjs:295-296`, allowed only when supervised; `app.onRestart` at `src/server.mjs:509`). The process printed `resumed after restart: find-appropriate-plots-to-buy-fo-b7772e` (lines 567, 591) before dying. Uptime at crash 1,207,907 ms ≈ 20.1 min → derived crash ≈ 2026-11-12T11:40Z (start logged 11:20:07Z).
- Exact error lines:
  - 598: `<--- Last few GCs --->`
  - 600–601: `[78426:...] 1207907 ms: Mark-Compact 2047.1 (2055.1) -> 2046.0 (2059.1) MB ... allocation failure; scavenge might not succeed` (and a `(reduce)` line at 601)
  - 602: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
  - 603–658: native stack — `RegExp::Exec` → `Builtins_StringPrototypeSplit` → `Builtins_ArrayFilter` → async microtask (one giant string split by a regex and filtered in a single turn).

### 1b. OOM crash B — pid 79167, lines 670–725
- Started by: same supervisor respawn after an in-app restart; printed `resumed after restart: find-appropriate-plots-to-buy-fo-b7772e` (line 664). Uptime 25,028,734 ms ≈ 6.95 h → derived crash ≈ 2026-11-12T01:20Z (start logged 2026-11-11T18:23:11Z).
- Exact error lines:
  - 671: `<--- Last few GCs --->`
  - 673–674: `Scavenge 2042.7 ... MB` / `Mark-Compact 2046.6 (2055.5) -> 2045.8 (2059.5) MB ... allocation failure`
  - 676: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
  - 677–725: native stack — `CompressionStream<ZlibContext>::AfterThreadPoolWork` (zlib thread pool) → `Buffer::FastByteLengthUtf8` → `String::Utf8Length` → `String::SlowFlatten` → `NewRawStringWithMap` (allocating one huge flattened string).

### 1c. Nine `ws` module failures — lines 1135–1305
- After `restart requested: saving handoffs…` (line 1134), the supervisor respawned the app 9 times; every spawn died instantly. Each block (1135-1153, 1154-1172, 1173-1191, 1192-1210, 1211-1229, 1230-1248, 1249-1267, 1268-1286, 1287-1305) contains:
  - `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ws' imported from /Users/m/free-research-llm/src/terminal/socket.mjs` (lines 1139, 1158, 1177, 1196, 1215, 1234, 1253, 1272, 1291)
  - `Node.js v24.22.0` (lines 1153, 1172, 1191, 1210, 1229, 1248, 1267, 1286, 1305)
- A start succeeded again at line 1306 once `node_modules` was restored. Related memory-leak warnings: `MaxListenersExceededWarning ... 11 terminated listeners added to [Fetch]` at lines 153, 166, 179, 192, 216, 229, 242, 255, 880. No `ENOMEM` or `EADDRINUSE` lines exist anywhere in the log.

## 2. Cause, proven from code and data

- Allocating load steps at startup:
  - `src/server.mjs:521-523` `app.resumeInterrupted()` → `src/app.mjs:449-465` → `engine.load()` → `store.get()` → `store.readFile()` (`src/store.mjs:88-90`): full `JSON.parse(await fs.readFile(...,'utf8'))` of `data/projects/*.json`. `find-appropriate-plots-to-buy-fo-b7772e.json` is 14.02 MB on disk (14,533,702 bytes per `docs/audits/recover-b7772e.md`: 30 nodes, sweep of 120 pages / 2,769 listings, 1,000 kept candidates, 266 report deliverables); the parsed object is several× the file size and is pinned in `store.cache` (up to 8 projects, `src/store.mjs:7, 76-86`).
  - `src/server.mjs:525` `app.settleStale()` → `src/app.mjs:517` `store.list()` → `src/store.mjs:228-235` → `summaryOf()` (`src/store.mjs:237-246`): full parse of every project file again just to summarize — 10 files, ~40 MB on disk in `data/projects/`.
  - `src/server.mjs:510` `app.seedLedger()` reads the last 500 lines of `data/logs/model-calls.jsonl` (5.03 MB); the App constructor loads `data/sites.json` (`src/app.mjs:176`; 43 KB now, ~2 MB in the audit era with 4,000 URL keys), `shares.json`, and the handoff dir; verification inputs live in `data/verification/` (b7772e inputs 5.38 MB).
- Heap limit: no `--max-old-space-size` anywhere — not in `start.command`, `package.json` scripts, or the spawn at `src/frl.mjs:306` (`spawn(process.execPath, [path.join(ROOT,'src','server.mjs')], …)`). Node v24.22.0 default limit; both crashes died at ~2047 MB (log lines 600-601, 673-674).
- The fatal allocations were single-turn bursts: crash A is a regexp `split` + `filter` over one huge string (shape matches `src/research/acceptance.mjs:216` `page.split(/[^a-z0-9]+/).filter(Boolean)` on a large page text); crash B is zlib compressing/measuring one giant string in the thread pool. The `HeapGuard` (`src/heapguard.mjs`: 1 GB limit, checked every 60 s, wired at `src/server.mjs:515-518`) never fired — `history.jsonl` contains zero `memory at … restarting gracefully` entries — because the heap jumped past 2 GB between two 60-second samples.
- The nine `ws` failures are environmental, not a code bug: `ws` is a declared dependency (`package.json`: `"ws": "^8.22.1"`) imported at `src/terminal/socket.mjs:1`, and it resolves in the checkout today. At that moment `node_modules/ws` was missing in `/Users/m/free-research-llm` — the same failure mode as the SESSION-LOG.md:813 incident (a deploy replaced `node_modules` with a self-link; restored with `npm ci`; `fix/untrack-node-modules` #58 merged as ea4a396, present in main).

## 3. Can it recur on current main?

Yes. On `main` (be8649e, == this worktree):
- Startup still full-parses every project file (`src/store.mjs:233, 243, 90`) and auto-resumes the 14 MB b7772e project into the cache (`src/server.mjs:521-523`).
- `HeapGuard` is only a 60 s sampled 1 GB tripwire; both proven crashes were single-turn bursts that crossed the 2 GB default heap within one interval, so the guard does not prevent them.

Concrete fix (one): give the spawned server a heap ceiling above the observed 2047 MB crash point — `src/frl.mjs:306` → `spawn(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, 'src', 'server.mjs')], { stdio: 'inherit', env, cwd: ROOT })`, and the same flag in `start.command` (`exec node --max-old-space-size=4096 src/server.mjs`). Test that would prove it: a test alongside the frl command tests that intercepts `node:child_process.spawn` and asserts `node src/frl.mjs start` spawns `process.execPath` with `['--max-old-space-size=4096', <ROOT>/src/server.mjs]` (mirroring the style of `tests/service.test.ts` / `tests/instancelock.test.ts`), plus a case asserting the flag also appears when the app is respawned by the supervisor.
