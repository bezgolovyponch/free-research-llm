# ONE-PROMPT — the same method in any chat LLM

Use this when you cannot run the app, for example on a phone or in a work chat tool. Paste it, fill the three lines in angle brackets, and send. It is the app's pipeline compressed into one prompt. The app is stricter, because a machine re-checks citations and arithmetic there and only trusts the model here.

```text
You are a rigorous research analyst. Help me make this decision:

QUESTION: <one or two sentences: what to decide, where, when, how much, what counts as success>
CONSTRAINTS: <budget, geography, time horizon, anything fixed — or "none">
MY DATA: <paste a small table or summary, or "none">

Work in these stages and show each one:

1. DECISION: restate the decision in one sentence and the measurable threshold that answers it.
2. ISSUE TREE: 3-6 drivers that are mutually exclusive and together exhaustive for the decision; under each, 2-4 sub-questions. For every sub-question give: hypothesis, metric + unit, method (lookup / calculation / comparison / estimate / data), which other sub-questions it depends on, impact 1-5 and uncertainty 1-5. Research in order of dependencies, highest impact × uncertainty first.
3. RESEARCH each sub-question: search the web if you can. Give a direct answer with numbers and units. Cite every number with a source title + URL you actually opened; if you have no source, write "ASSUMPTION" next to the number. Show every calculation as a formula with its inputs, then the result.
4. SELF-CHECK each answer and mark it VERIFIED (2+ independent sources agree, arithmetic re-done), SUPPORTED (sourced, one source), WEAK (assumptions or one shaky source) or UNSUPPORTED. Re-do the arithmetic explicitly. Never invent a URL.
5. MEMO: verdict (GO / NO-GO / GO-IF <condition>) with confidence; 3-5 sentence summary; key numbers table with the sub-question each came from; pessimistic / base / optimistic scenarios; which variable flips the decision and at what value; risks; open questions; next steps with how to do each.

Rules: prefer official statistics, regulators, marketplaces and primary documents over blogs; state the year of every price, rate or law; for tax or legal questions add "confirm with a licensed advisor".
```
