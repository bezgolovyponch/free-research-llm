# AUDIT PROTOCOL — mandatory for every task on this app

App changes start in the App chat as tickets (`data/changes/C<n>.md`, see [CONCEPT.md](CONCEPT.md#changing-the-app-from-the-app-chat)); the ticket's request and desired output are the S2 checklist. Anyone who changes this app or reports on it (a person, Claude Code, any agent) runs this protocol twice: **when a task starts** and **before the result is reported**. Nothing is reported as done until every check has a recorded answer.

It adapts three existing protocols instead of inventing a new one (and the mikoshi rule that the proof is chosen per change: a unit test for a pure function, a witness on real data for anything that acts on real data):

- **mikoshi-construct 0.43.0** (the construct used across this workspace): a pass is reported by the gate, never by the author; security is checked as its own dimension; every changed logic module ships with its test.
- **Chain-of-Verification** (Dhuliawala et al., 2023, arXiv:2309.11495): draft, list the verification questions, answer them independently, then revise. The app's own reply audit is built on it ([CONCEPT.md](CONCEPT.md#the-reply-audit-every-chat-every-reply)).
- **This app's protocols** ([PROTOCOLS.md](PROTOCOLS.md)): gates decide results; a model never grades itself.

## Part 1 · At the start of every task

| # | Check | How to answer it |
|---|---|---|
| S1 | **Concept fit.** Which flow, chat scope or document of [CONCEPT.md](CONCEPT.md) does the task touch? Does it keep "a model proposes, code decides"? | Name the flow. If the task would let a model create, delete, grade or run something without a button or a gate, stop and redesign |
| S2 | **Restate the ask.** List every numbered or separate request in the user's message, word for word, including ones sent mid-task | A checklist. Each item ends as done, blocked (with the reason) or asked |
| S3 | **Current state.** Read the code and the data the task touches before planning: the files, the live app (`node src/frl.mjs status`), the last handoff, the open items in [SESSION-LOG.md](SESSION-LOG.md) | File paths and the observed behaviour, not memory |
| S4 | **Facts that need a source.** Any price, limit, free tier, command, package name or API behaviour the result will state | Look each up in official docs (or test it live) now, and note the source and date |
| S5 | **Risk.** Does the task touch keys, the access token, remote access, the terminal, deletion, or anything that spends money? | If yes: write down the safe default and what needs the user's explicit consent |
| S6 | **Adjacent gaps.** What in the same flow would still be broken after the obvious fix? | Fix gaps in the same flow in the same pass; list the rest |
| S7 | **Witness on live data.** Does the change act on existing researches (repairs, re-grading, gates, scoring, item screening, routing on measured data)? | Before deploying, run it on a copy of the live research (`node scripts/dryrun.mjs <research id>`, or the equivalent read-only check) and read every change it reports. A wrong change found there is fixed before anything ships (2026-10-23: the candidates repair renamed "Market demand"; the speed check read a cached prompt as 0 tokens/s) |
| S8 | **Measurements.** Any before/after comparison | Times in one zone (UTC, with `Z`); windows and counts stated; too few samples are labelled as such |

## Part 2 · Before reporting the result

| # | Check | Pass when |
|---|---|---|
| O1 | **Every request covered.** Walk the S2 checklist | Every item is done, or its blocker is stated in plain words |
| O2 | **Gate.** `npm run quality` | It prints `quality gate: PASSED`. Quote its summary lines; never write "tests pass" without them |
| O2b | **CI before merge.** | The change is on a branch with a pull request, CI passes on Node 22 and 24, then it is merged; `main` is never pushed directly (the pre-push hook refuses it). New or changed tests pass 3 times in a row (`flakes` gate) |
| O3 | **Tests for changed logic.** Every new or changed module in `src/` | It has `tests/<same path>.test.ts` that fails without the change |
| O4 | **Real use.** The change works in the running app, not only in tests | Exercised through the HTTP API, the browser (e2e) or the terminal. Say which, and what was seen |
| O5 | **Every link in the report.** | Opened, or copied from a page that was fetched. No invented URLs, no `example.com` |
| O6 | **Every command in the report.** | Exists in this repo (`node src/frl.mjs …`, `npm run …`) or in the tool's official docs, and was run or syntax-checked where possible |
| O7 | **Every number and claim.** | Has its source (doc + date, or the command output). Unverified items are labelled as such |
| O8 | **No secrets.** | No key, token or passphrase in code, docs, logs, chat threads or the report. Placeholders such as `${VAR}` only |
| O9 | **No false claims of action.** | Every "created / deleted / pushed / installed" in the report matches a command whose output was seen |
| O10 | **Concept still holds.** Re-check S1 against the final change | Chats stay in their scope; nothing runs without a gate or a button |
| O12 | **Every suggestion is ready to execute.** Anything the app or the report tells the user to do | It names the exact URL, the exact button or field, and the exact command, taken from a provider's docs or this repo (key steps live in `src/llm/guides.mjs`). "Go to the website" alone fails |
| O11 | **Record.** | [SESSION-LOG.md](SESSION-LOG.md) has the session: what was asked, what changed, what is still open |

A failed check is fixed, then the whole of Part 2 runs again. If a check cannot pass (for example, a permission was refused), the report says so in the first lines.

## Part 3 · What the app enforces on its own replies

The same rules run in code on every chat reply, before you see it ([`src/chat/reply-audit.mjs`](src/chat/reply-audit.mjs)): unknown links removed, secret values removed, unknown commands flagged, placeholders flagged, claimed-but-not-run actions flagged, one revision on failure, then a visible **⚠ audit** mark. Tests: [`tests/chat/reply-audit.test.ts`](tests/chat/reply-audit.test.ts), [`tests/appchat.test.ts`](tests/appchat.test.ts).
