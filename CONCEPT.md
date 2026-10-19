# CONCEPT — what this app is, and what it is not

Free Research LLM answers **one decision question** with a researched, machine-checked answer, using only free model and search quotas. It runs on your own computer (macOS or Windows), or on a free cloud server, and you can open it from any device.

**Its one rule:** a model can propose, but only code decides what counts as a result. Grades, delivered links, calculations and "done" messages come from mechanical checks, never from what a model says about itself. The full rule set is in [PROTOCOLS.md](PROTOCOLS.md).

## The flows

| Flow | You do | The app does | What decides the outcome |
|---|---|---|---|
| Ask | Write a question and an expected result, then press **Build the tree** or **Research now** | Splits the question into a tree of pieces (sub-questions) | You review the tree before anything runs |
| Research | Press **▶ Run** | Searches, reads pages, answers each piece, reviews it with a second model | Gates: citations exist, links were seen on fetched pages, numbers are sourced, formulas are recomputed |
| Improve | Press **Improve loop** and set the hours | Changes one piece at a time, re-researches it, scores the whole tree | A change is kept only if the measured score rises |
| Results | Open the **Results** tab | Always shows a computed result: the verdict and a best estimate with a range, even when evidence is thin, marked **PROVISIONAL** with a confidence from the checks. Below it, every unsettled piece by name, tagged **Fix**, **Research further** or **Clarify**, with why and the next step. **Export:** report (.md), pieces & actions (.csv), delivered items (.csv), everything (.json), print/PDF | The checks decide the confidence and the action list (`src/research/gaps.mjs`), not the model |
| Talk | Use the chat in the side panel | Answers and proposes changes | Each chat has its own scope (below); every reply passes the reply audit |
| Operate | Press **Terminal**, or a command button | A real shell on the computer that runs the app, plus one-click commands for keys, links, always-on, updates and the quality gate | You type or press every command yourself |

## The screen, left to right

| Left | Middle (tabs) | Right panel |
|---|---|---|
| All researches; pick one | **Decomposition map** (dependency graph) · **Tree & pieces** (tree with checkboxes on the left; table of every piece and the selected piece's report on the right) · **Sources** (pick a piece, see the sources it used) · **Results** · **Report** (memo) · **Gates & logs** (every gate per piece, regression checks, loop trials, event log) | Everything you do: actions on the selected piece (re-research, split, suggest, add, edit, remove, files, instructions) and the chats |

Pieces keep the names of the first version: **Q** is the question, **D1, D2…** are drivers, **D1.1, D1.2…** are sub-questions, shown as `D1.1 · Model price scan` with the role. Each piece's report follows its role: a sub-question shows its research process (method, queries, pages, sources, answer, gates, reviewer, timeline); a driver shows what it rolls up; Q shows the decision, expected result, memo and drivers.

## Request, desired output and regression checks

Every message in a **Piece** or **Research** chat has two parts: the **request** (what you want) and the **desired output** (the result it should reach). The model turns the desired output into machine checks (grade, a number, a value range, linked items, required words), and code stores them on that piece (or on Q) as **regression checks** R1, R2… They are re-checked after every run. A check that passed once and fails later is marked **regressed**. This is reverse engineering: the target comes first, and the research is judged against it.

## The self-improving loop: whole research or selected pieces

Select pieces on the **Decomposition map** (**Select pieces**, then click them) or tick them in **Tree & pieces**, then choose **Improve loop ▾ → Selected pieces…**, or **Entire research…**. A selection sets the loop's focus: the request (Q), the whole primary level (D1, D2…), and along the path down to each selected piece, the pieces that share a parent with it, plus the selected piece's own sub-pieces. The children of other branches are left out. The map highlights the focus. Clicking a highlighted piece (or Q) excludes it and shows it with a dashed red ring; clicking it again brings it back. The loop changes and scores only the focus (grades plus their regression checks). In both modes a change is kept only if the score rises **and no passing regression check anywhere breaks**; otherwise it is reverted (`reverted-regression` in Gates & logs).

## Results that are always computed

The memo never stops at "insufficient data". The model must give a decision and a best estimate, using weak findings as low–base–high ranges and naming the node ids it rests on. Code then grades the result:

- **Provisional** while any piece is not verified or supported. Confidence comes from the checks: the share of passing pieces, and whether the pieces the memo relies on pass.
- **Action plan:** for each unsettled piece, code picks one action. **Fix** means the run errored, a source was invented, or a formula did not recompute. **Clarify** means the piece rests on assumptions or on an input only you can give. **Research further** means no number, unsourced numbers, a reviewer objection, or too few sources.
- **Order:** pieces are ranked by impact × uncertainty × how weak the grade is, a simple stand-in for value-of-information analysis. Pieces the memo cites (★) come first.
- **Buttons:** each row has **Re-research** or **Clarify in chat**.

## The four conversations, and why they never mix

| Chat | Where | It talks about | It can do |
|---|---|---|---|
| **Piece** | Side panel, a piece selected | That one sub-question | Edit, split, add or remove pieces, re-research, suggest sub-issues; attached files become sources of that piece |
| **Research** | Side panel, **Research** | The whole tree of one research | The same actions, on any piece of that research |
| **Results** | **Results** tab, or the **Results** chat button | What was delivered and how sure it is | Re-research, split or get suggestions for a weak piece |
| **App** | **App assistant** in the sidebar, or the **App** chat button | The app itself: how it works, keys, other devices, Windows, cloud, terminal, updates, all researches together, and **every change to the app** | Open or stop a research and show device links directly. It only **proposes** a new research, a deletion, a loop, a terminal command or an **app change ticket**: nothing happens until you press the button |

- A question about the app typed into a research chat is moved to the App chat, answered there, and never stored in the research.
- App reports (app started, keys reloaded, research created, finished, deleted, loop started or ended, resumed after a restart) are written into the App chat. Reports about one research are written into that research's chat.
- No chat can create, delete or start anything long-running by itself. That removes the failure where a chat model "created a research" from a request that was not a research.

## Changing the app from the App chat

Describe what to add, change or improve (features, tests, checks) in the App chat. It answers with an **app change ticket**: the request, a desired output you can check in the running app, and the tests to add. **Create ticket & implement** writes `data/changes/C1.md` and hands it to the app's **free-model coder** (`src/coder/`), which uses the same free keys as research:

1. It copies the app into a sandbox (`data/work/C1`). Code searches the files for the ticket's words, so the model starts from the right file; large files are shown as excerpts around those words. A free deep model then returns exact search/replace edits.
2. Code applies the edits in the sandbox only. Edits may touch `src/`, `tests/`, `e2e/`, `public/` and top-level docs, never the quality gate, the coder, auth, secrets, the terminal or `package.json`. A change may add tests, never remove them.
3. `npm run quality` runs in the sandbox. On FAIL, the failing tests and their assertions go back to the model: up to 6 model turns and 4 gate runs. If none passes, the app is unchanged. Every attempt is logged in `data/changes/C1.attempts.jsonl`.
4. On PASS, code backs up the original files (`data/work/C1.backup`), copies the changed files into the app, and restarts it when it runs as the always-on service. **Undo** next to the ticket restores the backup.

Every step is posted in the App chat. The model proposes the code; the gate decides whether it reaches the app. `node src/frl.mjs change C1` runs the same coder from the Terminal; `node src/frl.mjs change C1 --claude` hands the ticket to Claude Code instead (that uses your Claude plan).

## The reply audit (every chat, every reply)

Before a reply is shown, code checks it ([`src/chat/reply-audit.mjs`](src/chat/reply-audit.mjs)):

1. **Links:** every URL must be one the app knows: a page a research fetched, a link in the app's own guides, or this app's own address. Other links are removed.
2. **Secrets:** key and token values, real or invented ("API_KEY=…"), are removed.
3. **Commands:** shell commands must be terminal buttons or appear in the guides.
4. **Placeholders:** "example.com", "your-key", "Your commit message" are flagged.
5. **Claims:** "I have created / deleted / opened / pushed…" is flagged unless that action actually ran.

If a reply fails, the model gets the failures and writes it once more. If it still fails, the bad parts are removed and the message shows **⚠ audit**. A reply that passes shows **✓ audit passed**.

## Files in chats

Every chat takes up to 4 files per message (📎, drag and drop, or paste). Photos, screenshots, PDFs and MP3/WAV audio are read by a free vision model (Gemini, or a free OpenRouter model). CSV, TXT, MD, JSON and HTML are read by code. In a piece chat, the files also become cited sources of that piece. A model's reading of a photo counts as your evidence, not as a checked fact.

## The terminal

The **Terminal** button opens a real shell (zsh on macOS, PowerShell on Windows, bash on Linux) on the computer that runs the app. Every device that opens the app sees the same session, so you can start something on the Mac and watch it from a Windows PC or a phone. The buttons above it replace `start.command` and `keys.command`. They run the same `node src/frl.mjs …` commands on every system: status, links for other devices, restart, always-on, keys (add, check, list, export, import), update from GitHub, quality gate, and Claude Code.

From other devices the terminal is protected by the access token, like the rest of the app. Anyone with your token link controls that computer, so keep the link private.

## What the app is not

- It is not a general chatbot with hidden powers. The App chat knows only the facts and guides it is given, and says so when they do not cover a question.
- It does not write findings from a model's memory. Every finding needs sources the app fetched.
- It does not spend Claude credits. Research, the loop and app changes run on free keys. Claude Code runs only when you start it yourself (**Claude Code** button, or `change C<n> --claude`).

## Where things are

| Need | File |
|---|---|
| Step-by-step use | [GUIDE.md](GUIDE.md) |
| Windows PC | [WINDOWS.md](WINDOWS.md) |
| Always on in a free cloud server | [CLOUD.md](CLOUD.md) |
| Free keys | [KEYS.md](KEYS.md) |
| Models in a circle when quotas run out (FreeLLMAPI) | [FREE-ROUTING.md](FREE-ROUTING.md) |
| A model on your own GPU (Windows), optionally split across a second device | [LOCAL-GPU.md](LOCAL-GPU.md) · analysis and plan: [LOCAL-GPU-PLAN.md](LOCAL-GPU-PLAN.md) |
| How the router orders models | **Models & router** page (the **+** next to the models indicator): a strategy (Balanced, Fastest, Smartest, Custom) ranks the ready providers per role from the last 24 h of calls (reliability, median speed) and a capability rating; each place shows its reason |
| Rules the code enforces | [PROTOCOLS.md](PROTOCOLS.md) |
| Mandatory audit for anyone changing the app | [AUDIT-PROTOCOL.md](AUDIT-PROTOCOL.md) |
| Build history | [SESSION-LOG.md](SESSION-LOG.md) |
