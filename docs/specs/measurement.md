# Measurement: how a change to the engine is proven

Wave 1b of `docs/audits/engine-plan-2026-11-17.md`. Before this, a replay table could pass while the logic was wrong: agreement was percent agreement between two models, each replay ran once, and no judgement had a labelled answer.

## 1. What is measured

| Measured | Against | Script |
|---|---|---|
| A stage's stored answers (yes, no, not stated) | The labels of the reference set | `node scripts/measure.mjs score --reference <set> --answers <file>` |
| Two runs of the same stage | Each other, on the same items | `node scripts/measure.mjs compare --reference <set> --a <file> --b <file>` |
| Today's checklist judge | The reference set, on the stored pages | `node scripts/measure.mjs judge --reference <set> --out <dir>` |
| A purpose replay | Itself, over repeated runs | `node scripts/purpose-replay.mjs <mode> --out <dir> --runs 3` |
| A model's letter choices in closed votes | The even spread the rotation gives | `ModelRouter.letterBias()` from the call ledger |

## 2. The reference set

`node scripts/reference-set.mjs build --projects <dir> --replays <dir> --out data/reference/<name>` samples 150 to 300 judgements (default 240) from stored researches and stored replay outputs. Three tasks:

| Task | One record | Label means |
|---|---|---|
| `item-check` | An item page × one checklist question, or × the kind question | Does the page state it |
| `source-relevance` | A source page × the question of its piece (a research), or × the asked subject (a scoping replay) | Is the source about it |
| `fact-subject` | A quoted claim found on its source page × the question of its piece | Does the quote apply to the asked subject |

- **Labels:** `yes`, `no`, `not stated`. A stage's `unknown` is read as `not stated`.
- **Fixed pages.** The page text each record needs is written to `<set>/pages/<id>.txt`, cut at 40,000 characters. Sentence ids (`S1`, `S2`, …) come from `sentenceSpans` on that text, so a label, a judge answer and a later run all name the same sentences. Pages never go into git: an output folder inside the repository must be under `data/`.
- **Stratified by research type:** located listings, entity lists, knowledge questions, valuation, comparisons. The type is read from what the research stored (`researchType`), never from a word in its question; a replay takes its type from `scripts/purpose-replay.questions.json`; `--types <file>` overrides both.
- **Sampling.** Inside a task the types take turns, inside a type the researches take turns, inside a research its pages take turns, in an order fixed by `--seed`. One research gives at most 12 judgements a task (`--per-research`). `--require <id,id>` refuses to write a set that has no judgement from a named research.
- **Replay sources** carry no page text. `--fetch` reads each page once by code and stores it; without it they are counted as skipped.
- **Each record** has an empty label slot: `{ "label": null, "quote": null, "labeller": null }`.
- **Labelling.** `label-file --set <set>` writes the unlabelled records in batches of 25 with the sentences of each page. `merge --set <set> --labels <file>` takes a label only with the sentence id or ids that show it. A label without a sentence id is refused unless it is `not stated`. A label that differs from one already merged is refused unless `--replace` is given. Every refused label is listed with its reason.
- **Who labels.** The strong model labels, the owner spot-checks. The labeller's name is stored with each label.
- `answers-stored.json` holds the answers the researches and replays already gave to the sampled records, ready for `score`.

## 3. Formulas

- **Cohen's κ** = (p_o − p_e) / (1 − p_e). p_o is the share of items where answer and reference agree; p_e = Σ over labels of (share of references with that label × share of answers with that label). κ has no value when p_e = 1 (only one label occurs) and is printed as `n/a`.
- **Confusion counts:** a 3 × 3 table, rows the reference, columns the answer.
- **Wrong-no rate** (judge only) = answers `no` among the items whose reference is `yes` or `not stated`, divided by the number of those items.
- **Unknown rate** = answers `not stated` divided by all answers.
- **Every rate** is printed with its count and its 95% Wilson interval.
- **Paired difference.** Two runs are paired on the record ids both answered, each id once. Per item the score is 1 or 0 (agreement with the reference; for the wrong-no metric, a `no` on an item whose reference is `yes` or `not stated`). The difference is the mean of (B − A). The 95% interval is a percentile bootstrap of 2,000 resamples (`--resamples`), drawn with a seeded generator (`--seed`), **resampling whole researches**, because judgements on one research are not independent.
- **Spread over runs:** mean, lowest and highest of a rate over the runs, with each run's count.
- **Letter check.** For each provider, model, task and number of options, the chosen letters are counted from the call ledger. χ² = Σ (count − n/m)² / (n/m) with m − 1 degrees of freedom, against the even spread 1/m.

## 4. Sample floors

| Number | Floor | Below it |
|---|---|---|
| κ | 30 judged items | Printed with "too few: under 30" |
| Letter check | 10 answers per option (n ≥ 10 × m) | Not tested, never ranked down |
| Letter check, α | 0.01 | — |
| Reference set | 150 judgements | The build says the set is too small |
| Replay rates | 3 runs | One run is not a measurement |
| Paired comparison | Reported with its number of researches | With one research the interval has no width and proves nothing |

## 5. How a change is accepted

1. The reference set is split once into items a change may be tuned on and **held-out** items.
2. The change and its baseline are run on the same held-out items.
3. `measure.mjs compare` gives the paired difference with its bootstrap interval. The change is accepted only when **the interval excludes 0** in the wanted direction.
4. `npm run quality` prints `quality gate: PASSED`.

A replay table that looks better, percent agreement between two models, or one run is not evidence.

## 6. Votes the measurements rest on

- **Independent families.** A reply counts toward a quorum only when its family is not yet counted. A family is one vendor and one serving stack: two models served by one provider are one family, and one vendor's model on two providers is one family (`replyFamily`, `sameFamily`, `ModelRouter.familyOf`, `ModelRouter.families`). A second reply from a counted family is recorded as a repeat.
- **`single`.** When fewer than two families answered, `vote()` returns `{ value, single: true }`. `agreed(result)` is `null` for it. A caller may keep, order or rank on a single judgement; it never drops, vetoes, merges, rejects or makes something hard:

| Caller | On `single` |
|---|---|
| `requirement-split` | The piece is not split |
| `requirements`, `tensions`, `restates`, `ach-row` | They count replies; one reply groups nothing, names no tension, removes no question, marks no row |
| `consumes` | Undecided; both sides stay |
| `trace` | The goal is `proposed` with its leaning, to confirm |
| `obstacle-stated` | The obstacle stays soft |
| `same-goal`, `claim-pair`, the sample matching | Nothing is merged or linked |
| `number-kind` | The number is not moved |
| `source-role` | The role is `undecided`; an undecided role never drops a source |
| `subject-match` | No level; the fact is not applied |
| `kind-second` | The kind is `unknown`; the item is to confirm, never rejected |
| `hardness` | The requirement is not hard |
| `measure` | No measure is named; the question stays qualitative |
| The engine's kind second opinion | `unknown` with its reason; the item is not added to the rejected list |

- **`avoid` and `exclude`.** A caller's `avoid` list is used from the first attempt. `exclude` names judgements already given (`[{ provider, model }]`): their families never count, so a second opinion from the first judge's family is a repeat. The kind second opinion asks for one reply of a family other than the first judge's.
- **A split** with no majority records no outcome against any provider.
- **Rotation.** In every closed-choice vote, vote k shows the options rotated by k letters from a start that is a hash of the question, so over three votes each option sits under three letters and, across questions, each letter holds the right option equally often. That is what makes the even spread the expected one. The call ledger row carries `task`, `letter` and `options`. A model that fails the letter check is ranked down for closed-choice calls only.
- **Not rotated:** the relation letters of `trace` (S, R, X), the marks of `ach-row` (C, I, N), `true` or `false` answers, and single calls that are not votes (`source-relevance`, the first kind judgement). Their codes name their meaning.
- **Not built:** the router does not wait for a second family that is resting. When one family is reachable the vote asks once and returns `single`.

## 7. Sources

Ids as verified in `docs/audits/engine-sources-and-methods-2026-11-17.md` (2026-11-17; "P" there means the paper's own page was opened).

| Used for | Source |
|---|---|
| κ instead of percent agreement | Thakur et al., GEM 2025, arXiv 2406.12624 |
| A small labelled set to justify a model as annotator | Calderon et al. 2025, arXiv 2501.10970 |
| Error bars and paired comparisons | Miller 2024, "Adding Error Bars to Evals", arXiv 2411.00640. Its paired and clustered recommendations are in the body, which the audit did not see on the abstract page |
| Intervals from few labels and many votes (not built yet) | Angelopoulos et al. 2023, arXiv 2301.09633 |
| A fixed page corpus | BrowseComp-Plus, arXiv 2508.06600 |
| Option letters | Zheng et al., ICLR 2024, arXiv 2309.03882 |
| Votes on another provider than the author | Panickssery, Bowman & Feng, arXiv 2404.13076 |

Cohen's κ (Cohen 1960), the Wilson interval (Wilson 1927) and the percentile bootstrap (Efron 1979) are standard references that the audit did not open.
