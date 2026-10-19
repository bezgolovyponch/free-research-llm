# Security policy

Free Research LLM runs on your own computer and keeps API keys in the system key store. Please report anything that could expose keys, the access token, the terminal or other devices.

## Supported versions

Only the latest commit on `main` is supported. There are no released versions yet.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on https://github.com/bezgolovyponch/free-research-llm (or open a private security advisory). Do not open a public issue for a vulnerability, and do not paste real keys into an issue, a chat or a screenshot.

Please include: what you did, what happened, the app version or commit, the operating system, and whether remote access (`FRL_BEHIND_PROXY`, Tailscale Funnel) was on. Use placeholders such as `GEMINI_API_KEY=…` instead of real values.

## What to expect

- First response within 14 days.
- A fix on `main` with a quality-gate run attached, and credit in the release notes if you want it.
- No bug bounty; this is a free, single-maintainer project.

## Scope

In scope: key handling (`src/secrets.mjs`, `src/keybundle.mjs`), the access gate and token links (`src/auth.mjs`, `src/service.mjs`), the terminal (`src/terminal/`) including its WebSocket origin check, the app change pipeline (`src/coder/`), path handling in uploads and data files, and anything that lets one device act as another without the token.

Out of scope: risks that come from running the app with `--remote` on an untrusted network without the token, from giving a token link to someone, from pasting a key into a public chat, and from the free model providers' own policies.

## Hardening already in the app

- Keys live in macOS Keychain / Windows user environment / systemd encrypted credentials, never in a project file.
- Remote requests need the access token; requests forwarded by a proxy are not treated as "this computer".
- The terminal WebSocket rejects a foreign Origin; chats can only propose commands, never run them.
- App changes are implemented in a sandbox copy, may not touch the gate, coder, auth, secrets or terminal, and reach the app only after `npm run quality` passes.
- The quality gate scans for secrets on every commit.
