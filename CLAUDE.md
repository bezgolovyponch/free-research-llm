# free-research-llm

@CONCEPT.md
@AUDIT-PROTOCOL.md

- Every task runs the audit protocol above: Part 1 when it starts, Part 2 before the result is reported.
- Ship only through `npm run quality` (the pre-commit hook runs it). Live checks use the app's own free keys through its HTTP API; research runs never spend Claude credits.
- Keys live only in the system key store (macOS Keychain, Windows user environment, systemd encrypted credentials) or the shell environment, never in a file.
- No comments in source. Tests live in `tests/**` mirroring `src/`, e2e in `e2e/`.
- Build history and open items: [SESSION-LOG.md](SESSION-LOG.md).
- Temp and cache rules: [PROTOCOLS.md §5b](PROTOCOLS.md#5b-temp-and-cache-protocol). Scratch files go in the session scratchpad and are deleted when the task ends.

<!-- construct:begin -->
## Construct

This repository runs on a construct materialized by `mikoshi-construct` v0.46.0. The
discovery blocks — product, module map, commands, composition roots, dependency policy, high-effort
areas, defects vs accepted variance — live in [AGENTS.md](AGENTS.md), open questions in
[architecture/open-questions.md](architecture/open-questions.md); the
architecture, security and reasoning-budget rules in
[architecture/principles.md](architecture/principles.md); repository-wide code rules in
`.claude/rules/`.

- `/construct-discover` — fill or refresh the discovery blocks.
- `/plan <feature>` — decompose a feature into tasks with acceptance criteria and an effort class.
- `/implement <task>` — the reasoning-budget ladder: classify, implement at the lowest rung, verify
  with `npm run quality`, escalate only when verification proves it was not enough.
- `construct doctor` (or `npx mikoshi-construct doctor`) — check that the baseline and discovery are
  intact.

Who commits: the coordinating window and the factory commit, push and merge here; the implementer inside `/implement`
never commits. The owner's boundaries — the kinds of pull request only the owner merges — are the table in
[architecture/owner-merges.md](architecture/owner-merges.md).
<!-- construct:end -->
