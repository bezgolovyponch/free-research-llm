# GUIDE — exact steps to get an issue solved

## A. One-time setup (about 5 minutes)

1. **Install Node.js 20 or newer.** Get the LTS installer from https://nodejs.org. Check it with `node -v`.
2. **Get the app.**
   ```bash
   git clone https://github.com/bezgolovyponch/free-research-llm.git
   cd free-research-llm
   ```
3. **Get one free model key** (two is better, because when one quota runs out the app switches to the other):
   - Groq: https://console.groq.com/keys
   - Gemini: https://aistudio.google.com/apikey
   - Fully offline alternative: install Ollama (https://ollama.com/download), then run `ollama pull qwen2.5:7b`. It needs no key.
4. **Optional, for better sources:** get a free Tavily key (https://app.tavily.com), which gives 1,000 searches a month. Without it the app searches Wikipedia only.
5. **Store the keys in your shell, not in a project file:**
   ```bash
   echo 'export GROQ_API_KEY="paste-here"'   >> ~/.zshrc
   echo 'export GEMINI_API_KEY="paste-here"' >> ~/.zshrc
   echo 'export TAVILY_API_KEY="paste-here"' >> ~/.zshrc
   source ~/.zshrc
   ```
   You can also paste a key into the **Setup** tab. It is then kept for the current session only and is never written to disk.
6. **Start the app:** run `npm start`, or on a Mac double-click `start.command`. Open **http://127.0.0.1:4600**.
7. **Check Setup.** At least one provider must show **● ready** with a fast and a deep model. The header chip shows the active model.

To try the flow before you have a key, run `npm run demo`. Every answer is scripted and labelled DEMO.

## B. Solve an issue

1. **Ask tab: pick the problem type**: Car arbitrage, Glamping/hospitality location, Taxes, Market size, Any analytical question, or Auto-detect.
2. **Write the decision in 1–2 sentences.** Include *where, when, how much, and what counts as success*. Click "Use the example for this type" to see a strong question.
3. **Fill the detail fields.** For example: buy market and sell market, regions and capex, or country, tax year and income. Empty fields become assumptions that the memo lists for you to confirm.
4. **Optional: attach a CSV**, such as listings, bookings or invoices. The app profiles every column (count, min, p10, median, mean, p90, max, top values) and cites it as source **D1**.
5. Click **Research it →**. The **Tree** tab opens:
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
9. **Report tab:** verdict, key numbers (click one to jump to its node), scenarios, *what flips the decision*, next steps, risks and open questions. Use **⬇ Markdown** or **Print / PDF** to export it.
10. **Close the gaps.** Amber and red nodes, plus the memo's open questions, are your to-do list. Fetch the missing data, upload it as CSV, re-run with a hint, and repeat until the deciding nodes are green.

## C. Writing questions that work

| Type | Weak | Strong |
|---|---|---|
| Cars arbitrage | Is car flipping profitable? | Net margin per car buying 2015-2019 RAV4 hybrids under 150k km on mobile.de and selling on otomoto.pl, including transport, excise, registration, inspection and 30 days holding cost. Which specs clear €1,500? |
| Glamping | Where to build glamping? | Which of Šumava, Krkonoše, České Švýcarsko gives a 6-tent glamping site the best payback on €250k capex, target 60% occupancy and payback under 4 years? |
| Taxes | How to pay less tax? | Czech IT freelancer, €70k invoiced in 2026, no employees: total tax + social + health under flat-rate tax vs 60% lump-sum expenses vs an s.r.o. paying out dividends. |

Rules of thumb: give one decision per project; state numbers with currency and year; name the data sources you trust in the hint field.

## D. Troubleshooting

| Symptom | Fix |
|---|---|
| Setup shows "○ no key" everywhere | Run `export GROQ_API_KEY=...` in the **same terminal** before `npm start`, or paste the key in Setup. `start.command` loads `~/.zshrc`. |
| Provider "● error … HTTP 401" | The key is wrong or revoked. Create a new one. |
| "all free model quotas are cooling down" | The daily or minute quota is used up. Add a second provider or wait, then press **Run / resume**. |
| Many amber nodes saying "number(s) without source" | Search found little. Add `TAVILY_API_KEY`, upload a CSV, or re-research with a hint naming a site. |
| Tree is off-topic | Make the question more specific, edit the drivers, or delete them and add your own. |
| Port 4600 busy | Start with `PORT=4700 npm start`. |

## E. Run the tests

```bash
npm install     # once, installs vitest (dev only)
npm test
```
