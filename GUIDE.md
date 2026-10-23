# GUIDE — exact steps to get an issue solved

What the app is and how its chats work: [CONCEPT.md](CONCEPT.md). Windows PC: [WINDOWS.md](WINDOWS.md). Always on in a free cloud server: [CLOUD.md](CLOUD.md).

## A. One-time setup (about 5 minutes)

1. **Install Node.js 22.12 or newer (24 recommended).** Get the LTS installer from https://nodejs.org. Check it with `node -v`.
2. **Get the app.**
   ```bash
   git clone https://github.com/bezgolovyponch/free-research-llm.git
   cd free-research-llm
   ```
3. **Get free keys and save them.** The full list with verified limits and exact clicks is in **[KEYS.md](KEYS.md)**. The same numbered steps are in the app: **+** next to the models indicator → **Models & router** → **How to get it** on each provider, and in the terminal (`node src/frl.mjs keys list` / `keys set NAME` print them too). In short: create **Gemini**, **Groq**, **LangSearch** and **Tavily** keys (more is better: Mistral, Cerebras, NVIDIA, Exa, Jina; unlimited search: `node src/frl.mjs searxng`), then start the app, click **Terminal → Add keys** (or run `node src/frl.mjs keys setup`) and paste each key when asked. They are stored in the system key store (macOS Keychain, Windows user environment), not in a file. On a Mac, double-clicking **`keys.command`** does the same.
4. Alternative without the Keychain: put `export GROQ_API_KEY="…"` lines in `~/.zshrc`, or paste keys in the app's **Setup** tab, which keeps them for the current session only.
5. Fully offline option: install Ollama (https://ollama.com/download), then run `ollama pull qwen2.5:7b`. It needs no key.
6. **Start the app:** run `npm install` once, then `node src/frl.mjs start`. On a Mac you can double-click `start.command`, on Windows `start.cmd`. Open **http://127.0.0.1:4600**.
7. **Check Setup.** At least one provider must show **● ready** with a fast and a deep model. The **Routing** card shows which provider answers which role.

To try the flow before you have a key, run `npm run demo`. Every answer is scripted and labelled DEMO.

## B. Solve an issue

1. **Ask tab: pick the problem type**: Competitive strategy / action plan, Glamping/hospitality location, Taxes, Market size, Any analytical question, or Auto-detect.
2. **Write the decision in 1–2 sentences.** Include *where, when, how much, and what counts as success*. Click "Use the example for this type" to see a strong question.
3. **Fill the detail fields.** For example: buy market and sell market, regions and capex, or country, tax year and income. Empty fields become assumptions that the memo lists for you to confirm.
4. **Write the expected result**: what must exist at the end, e.g. "10 links to real listings priced 2000-4000 EUR" or "ranked list of 3 cities with rent per m² in EUR". The model turns it into checks that code runs on the final output (item count, live links, value range, required words).
4b. **Optional: attach a CSV**, such as listings, bookings or invoices. The app profiles every column (count, min, p10, median, mean, p90, max, top values) and cites it as source **D1**.
5. Click **Build the tree first →** (recommended) or **Build and research at once**. The **Tree** tab opens:
   - The **Q** node on the right is your question. **Drivers** sit in the middle and **sub-questions** on the left. Dashed purple lines mean "needs the answer of".
   - Node size is **impact × uncertainty**, so the biggest nodes are the ones most worth getting right.
   - Colours: grey pending → blue researching → **green verified / teal supported / amber weak / red unsupported**.
6. **Watch or step away.** A 12–20 node tree takes about 2–6 minutes on free tiers. If a quota is hit, the run switches provider or waits briefly. If it stops anyway, press **▶ Run / resume** later. Finished nodes are kept.
7. **Click any node** to see its answer, the cited claims (each [S#] links to its source), the machine-recomputed calculation, every check with ✓/✗, and the reviewer's verdict.
8. **Correct the tree where it is wrong:**
   - **✎ Edit question.** Use this when the sub-question is mis-scoped. It and everything above it are redone.
   - **↻ Re-research + hint.** Example hint: "use otomoto.pl asking prices, 2026, under 150k km".
   - **⤵ Break down further.** Splits a node that is too broad into 2–4 sub-questions.
   - **+ Sub-question / Remove.** Adds a missing factor or drops an irrelevant one.
   - Then press **▶ Run / resume**. Only changed branches are re-researched.
8b. **Chat with any node.** Click a node (or the Q root) and use **Chat**: ask why it was graded that way, or tell it what to change ("search otomoto in Polish", "split by fuel type", "re-research with 2026 prices"). It edits, adds, splits, suggests and re-researches nodes; its words never become findings: only research that passes the gates does.
8c. **🔎 Suggest researched sub-issues.** On any node or on the root. It searches first, then proposes 4–6 sub-issues, each marked **quoted from source**, **cites a source** or **not grounded**. Click **+ add as sub-issue** on the ones you want.
8d. **Instructions and direct pages.** Every node has an Instructions box (any rule, knowledge or method in plain words) and a list of pages to read directly. Save, then **Run**.
8e. **Self-improving loop.** On the Q root: set hours, press **▶ Start loop**. It changes one piece at a time, tests the piece and then the whole model, and keeps a change only if the measured score rises. Every trial is listed; **■ Stop** ends it.
9. **Report tab:** verdict, key numbers (click one to jump to its node), scenarios, *what flips the decision*, next steps, risks and open questions. Use **⬇ Markdown** or **Print / PDF** to export it.
10. **Close the gaps.** Amber and red nodes, plus the memo's open questions, are your to-do list. Fetch the missing data, upload it as CSV, re-run with a hint, and repeat until the deciding nodes are green.

## C. Writing questions that work

| Type | Weak | Strong |
|---|---|---|
| Competitive strategy | How do we beat our competitors? | 6-month action plan for our startup (paste its website address) against our two main rivals (paste their addresses) in the EU and US: which three actions have the strongest public evidence (their products, pricing pages, partnerships, papers)? |
| Glamping | Where to build glamping? | Which of Šumava, Krkonoše, České Švýcarsko gives a 6-tent glamping site the best payback on €250k capex, target 60% occupancy and payback under 4 years? |
| Taxes | How to pay less tax? | Czech IT freelancer, €70k invoiced in 2026, no employees: total tax + social + health under flat-rate tax vs 60% lump-sum expenses vs an s.r.o. paying out dividends. |

Rules of thumb: give one decision per project; state numbers with currency and year; name the data sources you trust in the hint field.

## D. Troubleshooting

| Symptom | Fix |
|---|---|
| Setup shows "○ no key" everywhere | **Terminal → Add keys** (`node src/frl.mjs keys setup`), paste at least one key. **Terminal → Check keys** tests them. |
| A chat reply shows **⚠ audit** | The reply had an unknown link, a key value, an unknown command or a claimed action that did not run. Those parts were removed. Ask again, or use the Terminal buttons |
| A message typed in a research chat moved to the App chat | It was about the app itself. App questions are answered only in the App chat (see [CONCEPT.md](CONCEPT.md)) |
| Provider "● error … HTTP 401" | The key is wrong or revoked. Create a new one. |
| "all free model quotas are cooling down" | The daily or minute quota is used up. Add a second provider or wait, then press **Run / resume**. |
| Many amber nodes saying "number(s) without source" | Search found little. Add `TAVILY_API_KEY`, upload a CSV, or re-research with a hint naming a site. |
| Tree is off-topic | Make the question more specific, edit the drivers, or delete them and add your own. |
| Port 4600 busy | Start with `PORT=4700 npm start`. |

## E. History and logs

- **History** tab: every session, research, verdict, expected-result score and loop, newest first. Each project links its **knowledge** record (facts / claims / hypotheses with evidence) and its full **log**.
- Files: `data/logs/history.jsonl`, `data/logs/project-<id>.jsonl`, `data/logs/model-calls.jsonl`, `data/logs/quality.jsonl`.

## F. Terminal, other devices, always on

The **Terminal** button (sidebar, or the `>_` icon on a phone) opens a real shell on the computer that runs the app: zsh on macOS, PowerShell on Windows. Every device that opens the app shares the same session. The buttons above it run the same commands on every system:

| Button | Command |
|---|---|
| Status | `node src/frl.mjs status` |
| Links for other devices | `node src/frl.mjs url` |
| Install always-on | `node src/frl.mjs install` (macOS login service, Windows logon task, Linux systemd) |
| Add keys · Check keys · List keys | `node src/frl.mjs keys setup` · `node src/frl.mjs keys check` · `node src/frl.mjs keys list` |
| Export keys · Import keys | `node src/frl.mjs keys export` · `node src/frl.mjs keys import` |
| Update from GitHub · Restart app | `node src/frl.mjs update` · `node src/frl.mjs restart` |
| Quality gate | `npm run quality` |
| (from an App chat change ticket) | `node src/frl.mjs change <id>` |
| Public HTTPS link | `tailscale funnel --bg 4600` |
| Claude Code | `claude` |

1. **Install always-on** makes the app start at login, restart if it stops, and accept other devices that bring the access token.
2. **Links for other devices** prints the links: this computer, your Wi-Fi (phone, other PC) and, with Tailscale on both devices, a link that works from anywhere. Open a link once on the other device; it remembers the token. The App chat can show the same links on screen (they are never saved in the chat).
3. Another computer with its own copy: **Export keys** here (choose a passphrase), **Import keys** there (paste the bundle, type the passphrase). The bundle is encrypted (AES-256-GCM, scrypt); send the passphrase separately.
4. Anyone with a token link can use the app and its terminal. To cut off old links: `node src/frl.mjs token --rotate`, then restart.

### One research on two computers (no Docker, no install on the second one)

1. This computer runs the app with remote access on (**Install always-on**, or `node src/frl.mjs start --remote`).
2. Open the research → **More → Share this research (link for another PC)… → Create link** → **Copy**. Or in a terminal: `node src/frl.mjs share` (lists research ids), then `node src/frl.mjs share <id>`, which also prints the Tailscale link.
3. Open the link in a browser on the other PC. If it does not open, first open `http://<this computer's Wi-Fi address>:4600/reachable` on the PC (the address is in the link). If that page does not load either, the network blocks it: both devices must be on the same Wi-Fi (not a guest network, which isolates devices), and a VPN on the PC must be off. History shows every other device that reached the app and whether it was let in. The same Wi-Fi works as is; from anywhere, install Tailscale on both computers and use the Tailscale link.
4. Both screens show the same research live. To work as a team on a running research or loop, press **⚡ Join** (the Run button while it works) or **Improve loop**: each press adds one lane (2 by default, up to 4), so more pieces are researched or tried at once. Lanes go back to 2 when it ends. Split the work: one runs or loops the research while the other chats with pieces, adds sub-issues, reads sources and downloads results. One run per research at a time; the other screen sees it as it happens.
5. The link opens only that research: no other researches, keys, settings, App assistant or terminal. **Turn link off** (same panel) or `node src/frl.mjs share <id> --off` cuts it at once. Rotating the access token turns every research link off.
6. **Let the other PC's graphics card research too (no Docker):** in the share panel copy the PowerShell line under "Let that PC's graphics card research too" and run it once in PowerShell on the PC. It downloads llama.cpp and a model that fits the PC's graphics memory and starts it; allow it when Windows Firewall asks. The app connects it within a minute of the PC opening the research link. By hand: `node src/frl.mjs local pc <PC address>`.
7. Nothing to clean on the other PC: it keeps only one cookie. This computer clears its own temp files every 6 hours and keeps at most 8 researches in memory (the rest stay on disk), so a second screen does not grow its memory.

## G. Check and ship changes

```bash
npm install       # once: installs vitest and activates the pre-commit gate
npm run quality   # syntax, secrets, no comments, a test per module, unit tests, mobile e2e (iPhone + Pixel)
```
A commit is refused while the gate fails. Rules: [PROTOCOLS.md](PROTOCOLS.md). Build history: [SESSION-LOG.md](SESSION-LOG.md).

### Change the app by talking to it

Open **App assistant** and describe the change in plain words ("make the Run button green", "add a CSV export to Results, with a test"). The assistant answers with a **ticket**: the request, the desired output you can check in the running app, and the tests to add. Nothing is created before you press a button. Then choose the implementer:

| Button | What runs | Cost |
|---|---|---|
| **Implement with Claude Code** | Claude Code edits a sandbox copy of the app (`data/work/C<id>`); the quality gate decides | your Claude plan |
| **with free models** | the free-model coder does the same with the free keys | none |

Progress, the files it touched and what Claude Code cost appear in the same chat. **Undo** and **Try again** (with either implementer) are next to the ticket in **App changes**. A follow-up message — "make it smaller instead", "that broke the export", "try again" — becomes the next ticket and starts from the app as it is now. Nothing reaches the live app without `quality gate: PASSED`; see [CONCEPT.md](CONCEPT.md#changing-the-app-from-the-app-chat).
