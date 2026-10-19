# Contributing

Thanks for helping. This project is small on purpose: a local research app that runs on free model and search quotas, with a hand-written quality gate. Contributions that keep it small and verified are welcome.

## Before you start

- Read [CONCEPT.md](CONCEPT.md) (what the app is and what it refuses to do) and [AUDIT-PROTOCOL.md](AUDIT-PROTOCOL.md) (the checks every change runs).
- Bugs and ideas: open an issue. Security problems: [SECURITY.md](SECURITY.md), never a public issue.
- Bigger changes: describe the change in an issue first, so we agree on the desired output before code.

## Set up

```bash
node --version        # 20 or newer
npm install           # installs vitest, Playwright and activates the pre-commit hook
npx playwright install chromium webkit
npm run quality       # the same gate CI runs
```

## Rules the gate enforces

- `npm run quality` must print `quality gate: PASSED`. A commit is refused while it fails; the pre-commit hook runs it automatically.
- Node ESM (`.mjs`) under `src/`. **No comments of any kind in source** (the gate checks every line).
- Every logic module `src/<path>.mjs` has a test at `tests/<path>.test.ts`. A new or changed module without a test fails the gate.
- UI flows get a Playwright case under `e2e/`; the suite runs on an iPhone (WebKit) and a Pixel (Chromium) profile.
- Never write a key, token or password into a file, a test, a fixture or a doc. Placeholders only: `GEMINI_API_KEY=…`.
- A model proposes, code decides: no feature may let a model create, delete, grade or run something without a button or a gate.

## Pull requests

1. One focused change per PR; say what the user can check in the running app.
2. Include the gate output in the PR description (copy the PASS/FAIL lines, not a summary).
3. Update [SESSION-LOG.md](SESSION-LOG.md) for a session-sized change, and the relevant doc (README, GUIDE, KEYS, CONCEPT) when behaviour changes.
4. Do not commit `data/` (keys, chats, researches) or `node_modules`.

## Reporting style

Results come from the gate, not from the author: quote command output, link to sources, and label anything you could not verify.
