# Open-source review — chat-to-code loops and repository standards

Checked 2026-10-19. Two questions: how do established open-source coding agents turn a chat request into a verified app change, and what does a small public Node.js repository need to count as "up to standards"? Sources are linked at the end; anything not verified by reading the project's own documentation is marked.

## 1 · How the established projects do it

| Project | Loop | Where edits land | Undo | Retry with test output | Progress |
|---|---|---|---|---|---|
| **Aider** | ask → code, or architect (planner + editor) | your working tree, auto-commit per edit | `/undo` resets aider's own commit; `/diff` | auto-lint each edit; `--test-cmd` / `--auto-test` feed failures back | token stream, per-message and per-session cost |
| **Cline** | Plan (read-only) → Act, approval per action | workspace, shadow-git checkpoints | restore files / task / both | watches linter, compiler and long commands | chat stream |
| **OpenHands** | conversation → agent event stream | optional Docker container; without it, full filesystem access | not verified | not verified | event stream |
| **Continue** | Plan (read-only tools) vs Agent | IDE workspace | apply-diff | tool result looped back | IDE stream (repo archived after 2.0.0) |
| **SWE-agent** | single loop: prompt → parse → shell action | Docker/ReX container per instance | patch artifact; no auto-apply by default | `RetryAgentConfig`, `max_requeries`, `cost_limit` | trajectory, no chat |
| **LibreChat / Open WebUI** | chat turn → sandbox command | ClickHouse code-interpreter sandbox (`/mnt/data`) | branch/commit reports | — | streamed status events |

The shared shape: **read and plan → propose edits → apply in an isolated copy → run the tests → feed the failures into the next attempt → checkpoint → human reviews the diff.** Projects differ in where writes land (working tree vs container vs shadow repo) and who approves (per action vs per task).

## 2 · What this app now does (adopted in this pass)

| Pattern | Where |
|---|---|
| Two implementers for one ticket, chosen per task: a capable agent (Claude Code) or free models | `src/coder/claude-code.mjs`, `src/coder/runner.mjs`, proposal buttons in `public/index.html` |
| Edits in an isolated copy; the live app changes only after the gate passes | `src/coder/sandbox.mjs` (`changedAll` now sees edits an agent made directly, ignores `test-results/`) |
| Feed the gate failure back into the next attempt, with a cap (2 Claude runs / 6 free-model turns, 4 gate runs) | `src/coder/claude-code.mjs`, `src/coder/free-coder.mjs` |
| No skip-permissions flag from a server; `--permission-mode acceptEdits`, sandbox as cwd, tool allowlist, hard timeout and kill | `src/coder/claude-code.mjs` |
| Cost of the run surfaced in the chat and the ticket (`total_cost_usd` from Claude Code's JSON output) | `claude-code.mjs`, ticket `result.summary` |
| One ticket = one thread: attempts logged, status, Undo, Try again with either implementer | `data/changes/C<n>.attempts.jsonl`, App changes panel, `GET /api/changes/:id` |
| Follow-up messages become the next ticket, starting from the app as it is | App chat prompt rule 4c |
| The gate stays the only write path into the app | no direct writes outside `sandbox.promote` |

Not adopted yet, deliberately:

- **Unified diff before apply.** Worth doing (Aider/Cline pattern), but it needs a diff viewer and an approval step that competes with the existing one-click flow; the gate already prevents unreviewed code from reaching the app.
- **A checkpoint per attempt inside the sandbox** (git commit per attempt, restore attempt N). Today the attempts log and the per-ticket backup cover the useful cases.
- **Token/cost cap that halts the loop.** Cost is reported; a hard budget needs a spend limit the user sets first.
- **Plan/read-only mode for the agent.** Today the agent is asked to finish in one run; a read-only planning turn would add a round trip and cost for little benefit on small tickets.

## 3 · Repository standards

Measured against GitHub's community profile, OpenSSF Scorecard and the Best Practices badge.

| Item | Before | Now |
|---|---|---|
| CI running the gate | none | `.github/workflows/ci.yml`, job `test`, Node 22 and 24, `npm ci`, Playwright browsers, gate, failure artifacts |
| Fail-closed e2e | gate skipped e2e when Playwright was missing, even in CI | with `CI` set, a missing Playwright fails the gate instead of skipping |
| Dependency updates | none | `.github/dependabot.yml` (npm + actions, grouped, weekly) |
| Security policy | none | `SECURITY.md` (private advisories, 14-day first response, scope, hardening) |
| Contribution guide | none | `CONTRIBUTING.md` (setup, gate rules, PR rules) |
| Editor / line endings | none | `.editorconfig`, `.gitattributes` (`*.cmd` CRLF, everything else LF) |
| Issue and PR templates | none | `.github/ISSUE_TEMPLATE/bug_report.yml`, `pull_request_template.md` |
| License, lockfile, README | present | unchanged |
| Lint | none (hand-written gate covers syntax, secrets, comments, test presence) | unchanged; see the decision below |
| Multiple Node versions tested | no | 22 and 24 in CI |

Still open:

- **`engines` floor.** `package.json` says `node >=20`; Node 20 reached end of life on 2026-03-24. CI already tests 22 and 24. Raising the floor to 22 is the correct next step, but the machine this app is developed on still runs Node 20, so the change needs to happen when that machine moves.
- **Tags and release notes.** `v1.0.0` with notes from `SESSION-LOG.md` would satisfy the badge's release-notes criterion. Not done here because no release was requested.
- **A linter.** Biome (lint only, no formatter) is the cheapest fit for ~50 untyped ESM modules: anonymous, unused or undefined identifiers are the bug class the hand-written gate cannot see. Not added yet because the first run needs triage before it can gate a commit; adding it blind would either fail every build or be ignored.
- **CodeQL / scorecard-action** as a separate non-blocking workflow. Deferred: it needs a second workflow and permissions review.
- **CODE_OF_CONDUCT, CODEOWNERS, signed releases, SBOM, 3-OS matrix.** Not worth it for a single-maintainer, unpublished app; Scorecard's code-review and contributors checks will stay low and that is accepted.

## 4 · Sources

- Aider modes, git and undo: https://aider.chat/docs/usage/modes.html · https://aider.chat/docs/git.html · https://aider.chat/docs/usage/lint-test.html
- Cline checkpoints and auto-approve: https://docs.cline.bot/core-workflows/checkpoints · https://docs.cline.bot/features/auto-approve
- OpenHands: https://github.com/All-Hands-AI/OpenHands
- Continue agent: https://docs.continue.dev/ide-extensions/agent/how-it-works
- SWE-agent config and retry: https://swe-agent.com/latest/reference/agent_config/ · https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py
- LibreChat code interpreter and PR reports: https://www.librechat.ai/docs/features/code_interpreter · https://www.librechat.ai/docs/features/pull_requests
- Open WebUI events: https://docs.openwebui.com/features/extensibility/plugin/development/events/
- GitHub community profile: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories
- GitHub templates: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates
- GitHub security policy: https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/add-security-policy
- OpenSSF Scorecard checks: https://github.com/ossf/scorecard/blob/main/docs/checks.md
- OpenSSF Best Practices badge criteria: https://www.bestpractices.dev/en/criteria/0
- Dependabot options: https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
- `npm ci`: https://docs.npmjs.com/cli/v11/commands/npm-ci
- Playwright CI: https://playwright.dev/docs/ci
- Node release schedule: https://nodejs.org/en/about/previous-releases
- Biome rationale: https://biomejs.dev/introduction/why-biome/
- ESLint setup: https://eslint.org/docs/latest/use/getting-started
