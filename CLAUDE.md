# free-research-llm

@CONCEPT.md
@AUDIT-PROTOCOL.md

- Every task runs the audit protocol above: Part 1 when it starts, Part 2 before the result is reported.
- Ship only through `npm run quality` (the pre-commit hook runs it). Live checks use the app's own free keys through its HTTP API; research runs never spend Claude credits.
- Keys live only in the system key store (macOS Keychain, Windows user environment, systemd encrypted credentials) or the shell environment, never in a file.
- No comments in source. Tests live in `tests/**` mirroring `src/`, e2e in `e2e/`.
- Build history and open items: [SESSION-LOG.md](SESSION-LOG.md).
- Temp and cache rules: [PROTOCOLS.md §5b](PROTOCOLS.md#5b-temp-and-cache-protocol). Scratch files go in the session scratchpad and are deleted when the task ends.
