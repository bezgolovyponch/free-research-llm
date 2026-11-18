# Security invariants

Security is its own review dimension. Each invariant names what enforces it; `review` means the
reviewer is the only check, so weigh those the most. `Enforced by` names the mechanism and what it
matches (the lint block and its selectors, the test file, the workflow job), never a bare tool name
such as `lint`, `CI` or `tests`, and it changes in the same change as the mechanism. A finding that recurs is an architectural
problem: move the protection to a shared boundary and add a check rather than fixing the symptom
again. Method: [principles.md § Security](principles.md#security).

The baseline rows below are enforced by files this construct materialized. Discovery adds the rows
that are specific to this system — the ones where money, identity or data can be corrupted.

| Invariant | Enforced by |
|-----------|-------------|
| No secret, token or connection string in any file, including gitignored ones; config references `${VAR}` placeholders | `.github/workflows/security.yml` runs gitleaks over the history on every push and pull request (`.gitleaks.toml` keeps the default ruleset live); review |
| Dependencies with known high-severity vulnerabilities are visible | `security.yml` runs `pnpm audit` weekly and on pull requests, reporting only |
<!-- construct:discover:security-invariants -->
| External verifier shares no code with the app | `scripts/quality.mjs` gate `independence` scans `verifier/**/*.mjs` for imports from `../src/`; fails if found |
| Research engine never writes to live app from a chat model | `src/chat/reply-audit.mjs` strips claims of create/delete/open/push unless the action ran; `src/coder/free-coder.mjs` runs in sandbox `data/work/C<n>/` and only copies on `npm run quality` PASS |
| Access token required for remote devices; loopback only on this computer | `src/auth.mjs` `AccessGate`: `isLoopback` allows 127.0.0.1/localhost/[::1]; `foreignHost` refuses non-local Host; `crossOrigin` refuses foreign Origin; share links scoped to one research via `shareAllows` |
| Decision criteria and hard checks never decrease on reference researches | NOT ENFORCED YET — reference-baseline check to be built from real post-revert reruns (see open-questions.md) |
<!-- /construct:discover:security-invariants -->
