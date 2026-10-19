## What changed

Briefly: the user-visible change and which flow it touches.

## Can be checked in the running app

How to see it: page, button, chat message, command.

## Gate

Paste the lines from `npm run quality`:

```
PASS  syntax        ...
PASS  secrets       ...
PASS  noComments    ...
PASS  testsPresent  ...
PASS  e2e           ...
PASS  tests         ...
quality gate: PASSED
```

## Docs and tests

- [ ] Tests added or updated (every changed `src/` module has `tests/<path>.test.ts`)
- [ ] e2e case for a UI flow
- [ ] README / GUIDE / KEYS / CONCEPT updated if behaviour changed
- [ ] SESSION-LOG.md entry for a session-sized change

## Anything unverified

Say what you could not run (another OS, a paid provider, a real device) instead of implying it was tested.
