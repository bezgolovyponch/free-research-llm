# Concept first: the engine against its own fundamentals (2026-11-18)

Auditor and builder: Claude Fable 5.2. Base: `main` 37d1bb7, plus `feat/measurement` 3b28b1d (#208). Briefs: `data/CONCEPT-FIRST.md` and its addendum. Line numbers are on 37d1bb7.

## How this was done, and what it did not do

- **Read in full:** `CONCEPT.md`, `FOUNDATIONS.md`, `docs/specs/purpose-decomposition.md`, `docs/specs/crucial-factors.md` (branch `feat/crucial-factors`), `docs/specs/leading-questions.md` (branch `feat/leading-questions`), `data/recent-work-2026-11-18.md`, `docs/audits/purpose-live-proof.md`.
- **Read in code:** `purpose.mjs`, `decision.mjs`, `checklist.mjs`, `verdict.mjs`, `acceptance.mjs`, `concept.mjs`, `domain.mjs`, `deeper.mjs`, `spans.mjs`, `candidates.mjs:155-370`, the engine's stages (`engine.mjs:292-336`, `:471-572`, `:656-677`, `:803-1095`, `:1781-2004`, `:2024-2181`), the result panel of `public/index.html`, and `semantic.mjs` of `feat/measurement`.
- **Run (read-only, no model call, no page fetch):** `node scripts/dryrun.mjs <id>` on the three stored researches; `git log -S` for every line cited below; three scratch scripts that print the stored decision model, domain, pieces, hub sources, candidate rows and deliverables.
- **Not run:** any live research, any model call, the quality gate. The stored projects are from 2026-11-12 (decision model version 2, no purpose tree, no checklist, no judged checks). So what main does with them from the tree onward is read from code and from `purpose-live-proof.md`, not reproduced. Each such statement is marked *(read)*.

## 1. The intended pipeline

From CONCEPT ("what counts is fixed first", "Concept brief first", "Checks come from your words"), FOUNDATIONS F1, F3, F4, F6, F10, F11, and the review method they cite (PRISMA 2020; JBI Population, Concept, Context).

| # | Stage | What it fixes | Fundamental |
|---|---|---|---|
| 1 | Concept framing | **Population:** the unit delivered. **Concept:** what each unit must be or offer, including the class the asker's examples define. **Context:** the purpose and the setting. Limits (numbers with units) and superlatives (they rank) are named apart. Every element carries the asker's own words | F1, F3 |
| 2 | Domain study, started from the request's examples | The class (other members, by co-occurrence in sources), how the trade offers such items, its vocabulary in the market's languages, where items are listed, what on a page shows eligibility | F1, F10 |
| 3 | Eligibility criteria | One criterion per concept element, with the domain's anchors, fixed before search and calibrated on real candidate titles and pages (positive and negative examples; the owner labels examples when calibration cannot settle) | F3, F6 |
| 4 | Search | Queries in the domain's vocabulary | F4 |
| 5 | Screening | Every candidate against every criterion, by meaning, with a quote. Unknown is "to confirm" | F4, F10 |
| 6 | Appraisal | Only the eligible are ranked, by the superlatives and the purpose's crucial factors | F11, F12 |
| 7 | Result | The eligible items, each with its evidence per criterion; the screen lists the criteria with the share meeting each | F11 |

## 2. The pipeline as it runs on main

Order of a run (`engine.mjs:2042-2146`): `studyDomain` → `searchHubs` → `decompose` (decision model, then scoping and the purpose tree, then the piece tree) → `ensurePurpose` → `validateConcept` → portal sweep and candidate table → pieces → `checkAcceptance` (deliverables, live and range checks, checklist judge, deeper reads, verdict).

| Stage on main | Code | What it does |
|---|---|---|
| Kind | `decisionPrompt` (`decision.mjs:290`), `normalizeSample` (`:114`), `aggregate` (`:194-195`) | Three samples each write "a short label" for "the item the user wants listed", cut at 60 characters; the most frequent label wins. No part of the label is tied to the asker's words |
| Criteria | `aggregate` (`decision.mjs:171-187`) | Only clauses one of 15 code measures can test become criteria. Every other clause goes to `missing` ("not modelled") |
| Examples | `nameLists`, `purposeChecks` (`acceptance.mjs:166-201`) | Capitalised names in a comma list become "page mentions one of" (substring or edit distance 2) |
| Domain study | `domainQueryPrompt` (`domain.mjs:83-124`), `domainUnderstanding` (`:335-359`) | Eight fixed aspects of "the trade around the object"; ready when the object and one term are supported. The prompt forbids the examples (`:118`) |
| Hub search | `hubQueryPrompt` (`domain.mjs:44-72`) | Queries per hub country in its language |
| Scoping | `runScopingStage` (`engine.mjs:808-831`) | Subject = the kind label; purpose = the decision model's; "requirements" = the piece questions, which do not exist yet when it runs inside `decompose` (`:485`, `:810`) |
| Purpose tree | `buildPurposeTree` (`purpose.mjs:961-1000`) | Requirements split at commas and grouped; goals drafted, traced, refined into at most three questions each; every uncovered clause becomes a goal of its own (`coverAskedClauses`, `:946`) |
| Hardness | `voteHardness` (`purpose.mjs:869-880`), `buildChecklistFromTree` (`decision.mjs:527-554`) | One vote per clause: "constraint" only with an exclusive word, else "criterion". Every `page` question under a constraint clause is a veto (`:549`) |
| Concept validation | `validateConcept` (`engine.mjs:987-1027`) | Only for kinds no portal lists; learns phrases and near-miss phrases; runs after hub search and the trees |
| Calibration | `calibrateKind` (`engine.mjs:1068-1095`) | Only with a portal sweep and `kind.verified`; learns exclusion words and model names from titles |
| Deliverables | `entityDeliverables` (`acceptance.mjs:459-587`), `candidateDeliverables` (`candidates.mjs:341`) | Businesses: a page is admitted by counting kind terms (`:523-537`). Listings: table rows that count |
| Judge | `ChecklistJudge` (`checklist.mjs:296-402`), built without an embedder (`engine.mjs:335`) | Reads the first 6,000 characters of the page; one reply per question; a "yes" counts with any existing sentence id |
| Verdict | `verdict` (`verdict.mjs:114-306`), `qualifies` (`:16-20`) | Confirmed when no hard goal is "no" or "unknown" and the kind check is "yes" |
| Result screen | `public/index.html:1637`, `:1644` | The list of acceptance checks, then a table of title, value and link |

## 3. The three researches

### 3.1 Suppliers b2f5b7

**Question.** "Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic". **Hints.** "branded vintage clothing wholesale: graded A/cream, sold per kg in bales or curated bundles, suppliers in NL, DE, UK, IT, PL, LT". **Expected.** "20 direct links to the providers with proposal and proof …".

**Intended framing.**

| Element | From the asker's words |
|---|---|
| Population | "providers": one business per result, delivered as a direct link to it |
| Concept | (a) it sells **wholesale**; (b) what it sells is **branded second hand clothing**; (c) the brands are of the class the four examples define ("similar to Ralph Lauren, Monclair, North face, Barbour"); (d) "proven good quality"; (e) an "assortiment" that fits a retail second hand shop |
| Context | A retail second hand shop business in the Czech Republic (where the result is used, not where the supplier sits) |
| Limits | None with a number. Count: 20 |
| Ranks | "highest price/value ratio" |
| Hints | Vocabulary and places to look: seeds of the domain study, never criteria |

**What main does.**

| Stage | Observed | Requirement lost, demoted, rewritten or judged by words |
|---|---|---|
| Kind | Stored label: "wholesale clothing provider"; terms "wholesale used clothing", "second hand clothes", "used clothing wholesale" | **Rewritten.** "branded" and "second hand" left the label; the class of brands never entered it |
| Criteria | 0 criteria; all five clauses "not modelled" | **Lost** from the decision model |
| Examples | `purpose-names-1`: "Page mentions one of: Ralph Lauren, Monclair, North face, Barbour" | **Judged by words**: a supplier of Burberry and Patagonia fails; a blog naming Ralph Lauren passes. Stored: 1 of 3 |
| Domain study | Stored terms: "branded vintage clothing wholesale", "graded A", "cream", "suppliers in NL" (the hint's own phrases, `supportedHintTerms`). No class member learned, no statement of what a supplier's page shows. Two of ten hosts are a Chinese marketplace store | The prompt says "Never ask about the history of the brands or the products named in the question" (`domain.mjs:118`): the examples are excluded from the study by instruction |
| Pieces | D1 to D6 search for, price, grade and rank suppliers by web search (D6.2 "List direct URLs": 37 items) | Identification done by models over search results (A11, A23) |
| Hub search | 43 pages: 9 directory pages, 2 CBD spam pages, a banana price article, a dictionary on Scribd | Queries built from the degraded kind and the hint, not from the class |
| Tree, hardness *(read)* | `purpose-live-proof.md:21`: "9 goals, no hard item but the kind check" | **Demoted.** Every clause was voted "criterion" because none holds an exclusive word |
| Named examples under a tree *(read)* | `qualifies(..., { namesVeto: false })` (`verdict.mjs:179`) | **Demoted** to a score (67ef503) |
| Kind judge *(read)* | Option A: "one wholesale clothing provider: a single business, on its own website or its own profile page, whatever range of goods it shows" (`checklist.mjs:265`) | **Rewritten.** The judge is told the goods do not matter |
| Deliverables | 90: 83 directory profiles, 7 own sites. For 5 of the 7 the page judged and titled is a deep page (`/nl/used-clothing`, `/second-hand-clothing`, `/trends/character-t-shirts`) | The item shown is a category or article page; the delivered link is the root |
| Verdict *(read)* | Eligible = kind "yes" with any quote + live | Any single business that sells used clothing wholesale is valid |
| Screen (owner's run) | "At least 20 valid items 95%", "Page mentions one of … 11%: 3 of 27", "Checklist: kind 73%" | No row for branded, second hand, the class, quality or assortment |

**Delivered when stored against now.** Stored result (2026-11-12): 3 inspected, 1 "valid". Dry run of main on the stored pages: 90 deliverables; none can be judged without a model; 2 of the 7 own-site pages name an example brand, and one of those two is an article about character T-shirts. The owner's live run on main: 19 of 20 "valid" with 3 of 27 naming a brand, so at least 16 valid items had no evidence of the class.

**Not eligible under the concept:** every delivered business whose page does not show branded goods of the class (generic used-clothing bale and rag exporters); every delivered page that is not a business (the trends article, the guide pages); every item whose only evidence is a category or product title.

### 3.2 Cars 0c750f

**Question.** "Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent". **Expected.** "The list of 20 highest possible price/value ratio to buy, working links, no broken links, verified with the research logic, recently posted, 80 trade offs to confirm and review".

**Intended framing.**

| Element | From the asker's words |
|---|---|
| Population | "car listings on available marketplaces": one listing of one car offered for purchase |
| Concept | (a) a **car**, not a part of one; (b) "hatchback"; (c) "accurate and verified"; (d) "working links, no broken links"; (e) "recently posted" |
| Context | To purchase; near Prague |
| Limits | "within 300km from prague"; "price up to 65000CZK or equivalent". Counts: 20 fits, up to 80 trade-offs |
| Ranks | "highest price/value ratio" |
| Method | "considering the engines informations, usage trends and empirical data …", "considering the professional and car enthusiast trustful sources and communities", "with all the crucial metrics considered": how the ranking is to be done, properties of the appraisal, not of a listing page |

**What main does.**

| Stage | Observed | Requirement lost, demoted, rewritten or judged by words |
|---|---|---|
| Kind | Label "used car", terms `["hatchback"]` | The concept word became the kind's only term; "listing on a marketplace" is not in it |
| Criteria | 0 (stored); all seven clauses "not modelled", among them both limits | The limits live elsewhere: `valueRange` and the radius-to-countries rule |
| Calibration | `subtype.models`: 16 names learned from titles, among them "prodam citroen c1" and "prodam citroen" ("prodam" is Czech for "I sell") | **Judged by words.** "Hatchback" is "the title holds a model name of the list" (`candidates.mjs:176-180`); a hatchback of a model outside the list is "to check" (2,546 rows) |
| Population | First kept row of the stored table: "Motor dacia sandero", 25,000 CZK (an engine). It is also the first delivered item | **Judged by words.** A part passes because its title holds the model name (A14 again) |
| "accurate and verified", "recently posted" | No check anywhere in the stored research. The stored domain holds statements about warranties and appraisal reports | **Lost** |
| Pieces | D3 "Price/Value Ratio", D4 "Seller Trust", "Does Autoportal mark verified sellers?" | The quality words became knowledge pieces, 5 of 6 weak or unsupported, feeding nothing |
| Checklist before #202 *(read, `purpose-live-proof.md:10`)* | Hard checks: "accurate and verified listing, hatchback, engine information, trusted sources, crucial metrics" → 0 of 20 confirmed, 58 rejected | The appraisal method ("considering …") was asked of every listing page as a veto: **replaced by model-made page questions** |
| Tree after #202 *(read, `:23`)* | Hard: "hatchback stated on the page", distance, price → 7 confirmed, 31 to confirm "(body type not stated on the page)", 52 rejected by the kind check | "Hatchback" is now decided twice, by two rules that disagree: the table's model list keeps the row, the page question finds no sentence. "accurate and verified" is soft, so it decides nothing |
| Price limit in the judge *(read)* | `MEASURES.priceEur.read` returns the row's raw price (`checklist.mjs:183`); the threshold is compared with it in whatever currency the row has | The stored table holds one PLN and one EUR row among 203 CZK rows; a PLN price is compared with a CZK limit as a bare number |
| Screen | "At least 20 valid items: 30 of 205", "Links open", "Value within 0–65000 CZK", "Page shows the asked hatchback (your words)" | No row for accurate, verified, recently posted |

**Delivered when stored against now.** Stored: 205 kept rows, 30 inspected, 30 "valid". Main now *(read)*: 7 confirmed of 90 judged. **Not eligible under the concept:** "Motor dacia sandero" and every other part or engine listing; every listing with no evidence of being verified or recent (all of them: nothing checks it).

### 3.3 Plots b7772e

**Question.** "Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike". **Hints.** Land that needs work is in scope; "accessible by e-bike" means about 20 km. **Expected.** "50 Plots In EU, Vietnam and Turkey strongly feasible for Glamping business 10 minth, 1 year".

**Intended framing.**

| Element | From the asker's words |
|---|---|
| Population | "plots to buy": one listing of one plot of land for sale |
| Concept | (a) "appropriate … for glamping business" (it can hold glamping units, legally); (b) "mild climate … so no air condition"; (c) "nearby sea or the ocean accessible by ebike" |
| Context | A glamping business with a very low entry investment; EU, Vietnam and Turkey |
| Limits | "20000EUR max"; "10 month a year"; from the hint, about 20 km to the sea |
| Ranks | "strong price increase trend"; "very low enterance investments" |

**What main does.**

| Stage | Observed | Requirement lost, demoted, rewritten or judged by words |
|---|---|---|
| Framing | The hand-written strategy `GLAMPING_LOW_ENTRY` (`strategy.mjs`) plus the voted decision model: price ≤ 20,000 EUR, trend above the EU, ≥ 10 workable months, sea ≤ 20 km | This is the one research where eligibility **is** fixed first and measured by code. It is fixed by a hand-written case, not learned (FOUNDATIONS row 1 says so) |
| "strong price increase trend" | A veto: `realTrendVsEu > 0` | **Rewritten:** a superlative that should rank is a hard criterion. 255 of 1,000 kept rows are Turkish; #207 changed which side of the veto they fall on by changing the window's start year (audit P1-5) |
| Screening | Table tiers: 273 fits, 160 trade-offs, 449 to confirm, 113 weak, 5 blocked. External verifier: 332 confirmed, 496 refuted | By code, with measured values. 266 rows count |
| Tree since #202 *(read)* | `ensurePurposeTree` runs for every research with an item count (`engine.mjs:834`), a strategy or not, and `rebuildDecisionModel` replaces the checklist with the tree's. `checkAcceptance` then judges up to 90 delivered pages against it (`:1822-1933`) and the count comes from that verdict (`:1976-2003`) | **The table is no longer the result (F11).** A row that fits every measured check and was confirmed outside the app is "to confirm" or "rejected" when a listing page does not state what the tree asks |
| Hardness *(read)* | "so no air condition" holds the word "no", one of the ten cue words of `voteHardness` (`purpose.mjs:871`) | A page question such as "does the page state no air conditioning is needed" becomes a veto on a land listing |
| Numeric checks *(read)* | The judge reads measures from the delivered item (`checklist.mjs:182-197`), but `candidateDeliverables` passes only title, link, price, currency and distance (`candidates.mjs:342`) | Sea distance, months and heat are **unknown** for every plot in the judge although the table measured them. `priceEur` reads 255 TRY prices as EUR, so a 500,000 TRY plot fails "≤ 20,000" |
| Witness | `purpose-live-proof.md` covers suppliers and cars only | #202 shipped without a witness on the research that has a strategy (AUDIT-PROTOCOL S7) |
| Screen | "At least 50 valid items", "Value within 0–20000 EUR", "Page shows the asked plot (your words)" | The measured criteria are in the candidate table, not in "Expected result" |

**Delivered when stored against now.** Stored: 266 rows count (fits and confirmed), 75 inspected, 75 "valid". Main now *(read)*: at most 90 pages judged; the site measures are unknown to the judge, so none of the 266 can be confirmed by it whenever the tree holds one hard numeric goal on a site measure. **Not eligible under the concept:** none of the 266 by the measured criteria; the flaw here is the reverse, eligible rows turned into "to confirm".

## 4. Where main departs, ranked by harm across the three

"S", "C", "P": suppliers, cars, plots. Commits found with `git log -S` on the cited text.

| # | Departure | Where | Commit (PR) | Harm |
|---|---|---|---|---|
| D1 | **The decision model can only hold a requirement that is one of its 15 measures.** The concept is in the design and in code: `decomposePrompt` (`prompts.mjs:60-95`) gets the question, the expected result, the concept brief and the decision model and decomposes backward from the expected result; acceptance comes from the expected result; the improve loop scores against it; the domain study reads real pages before planning. What fails is one link: `aggregate` keeps a criterion only when it maps to a quantity in `MEASURES` (built for plots), so a class with its examples, a quality or a property is "not modelled" and falls to a model-written checklist (everything hard) or, after #202, to the tree (nothing hard). The domain study's findings feed only the hub search and the deliverable terms, never `decomposePrompt` or the judge. (Corrected 2026-11-18: the first version of this row said "no concept exists", which was wrong.) | `decision.mjs:25-45`, `:171-222`, `:290`; `engine.mjs:662`, `:686`, `:1720` | 6cb964a (#20, 2026-10-27); e9911e6 (2026-11-05) | S: all five clauses unmodelled. C: all seven. P: four. Every later stage inherits it |
| D2 | **Eligibility replaced by a clause-by-clause hard/soft vote on wording.** "Constraint" needs an exclusive word; a description of what the item must be is "criterion" | `purpose.mjs:869-880`, `decision.mjs:527-554` | 556cc4e, eb88445 (#202) | S: nothing is required but the kind. C: "accurate and verified" decides nothing. P: "no air condition" becomes a page veto |
| D3 | **The kind loses the asker's qualifiers**, and for businesses the judge is told the goods do not matter | `decision.mjs:114`, `:194-195`; `checklist.mjs:265` | 6cb964a; 747cd66 (#206) | S: any used-clothing wholesaler is the asked kind |
| D4 | **Examples are words to match, then a score, never seeds or anchors.** The domain study is told to avoid them | `acceptance.mjs:166-201`, `:247`; `verdict.mjs:16-20`, `:179`; `domain.mjs:118` | 6674a3a (2026-11-04); 67ef503 (#202); de441f4 (2026-11-05) | S: the class is never learned and never required |
| D5 | **The domain study does not learn what eligibility needs**: no class members, no statement of what a page of an eligible item shows. Its findings never reach the judge | `domain.mjs:74`, `:335-359`; `engine.mjs:866-921` | e9911e6, de441f4 (2026-11-05) | S, C: the stored domain is vocabulary from the hint and unrelated statements |
| D6 | **Case words written into the engine**: "vintage groothandel", "Vintage Großhandel", "bales, per kg, B2B, export" in the hub prompt; `HARD_SEA_KM`, `HARD_CAMPING_MONTHS` applied to every research, with the car's distance from Prague read as a sea distance | `domain.mjs:65-67`; `candidates.mjs:212-227` | cffa1f4, b4b9273 (2026-11-05); 3a30cff (2026-11-12) | S: hub queries carry one trade's words. C: a car more than 20 km from Prague is not a "hard pass" |
| D7 | **The tree replaces the table and the strategy instead of hanging from them.** A tree is built for a research whose eligibility is already measured; its page questions overrule measured checks; the judge cannot see the measurements | `engine.mjs:833-864`, `:1822-1933`, `:1976-2003`; `candidates.mjs:342`; `checklist.mjs:182-197` | 556cc4e, 3c09527 (#202) | P: confirmed fits become "to confirm". C: "hatchback" decided twice |
| D8 | **Order: eligibility is not fixed before search.** Hub search and both trees run before the concept is validated; the candidate pool is never used to calibrate criteria for businesses | `engine.mjs:2042-2059`, `:1068-1072` | 0afc298 (2026-11-04), b7196b9 (#204) | S: 43 hub pages found with the degraded kind |
| D9 | **Scoping is given no concept.** Subject = the kind label; "requirements" = piece questions that do not exist yet | `engine.mjs:808-831` | 3c09527 (#202) | S: scoping studies "wholesale clothing provider". The plan to retire the domain and concept stages for scoping (`engine-plan-2026-11-17.md:18`) would have removed the only stages that look at the item |
| D10 | **Hints bypass the two pauses that protect the concept**: any hint text skips "purpose not clear" and "pages name the item in different words" | `engine.mjs:929`, `:1007-1011` | 0afc298; 17d3bf6 (#205) | S: the research runs on with an unvalidated kind |
| D11 | **Admission and identity by counting words**: two kind terms admit a page; a title word excludes it; a model name in a title makes a hatchback and a car | `acceptance.mjs:523-538`; `candidates.mjs:176-180` | 9443005 (#201); earlier | S: a trends article is a supplier. C: an engine is a car |
| D12 | **A quote is any sentence**: the judge reads the page opening (no embedder) and a "yes" counts with any existing sentence id | `engine.mjs:335`; `checklist.mjs:13-20`, `:285-294` | fb1cb79 (2026-11-13), 2c96e0a (#190) | S: menu and shop text as evidence ("woocommerce") |
| D13 | **"Valid" includes silence.** A hard goal with no check on the item is skipped; a goal with only non-page questions has no check | `verdict.mjs:150-152` | 556cc4e (#202) | S, C |
| D14 | **Appraisal method asked of each item.** "Considering engines, trusted sources, crucial metrics" became page questions | legacy `checklistPrompt` (`checklist.mjs:220-226`); `coverAskedClauses` (`purpose.mjs:946-959`) | fb1cb79; 67ef503 (#202) | C: 0 of 20 before #202; soft noise after |
| D15 | **The result screen does not show the criteria.** It lists the count, links, the lexical name row and "Checklist: kind"; soft goals were removed from it; the item table has no tier and no evidence | `acceptance.mjs:707-719`; `verdict.mjs:213`; `public/index.html:1637`, `:1644` | 265edd0 (#205) | S, C, P: the asker cannot see which requirement an item meets |
| D16 | **A ranking word used as a veto** ("strong price increase trend") | `strategy.mjs` `trendAboveEu` | 5b46b73 (2026-10-26) | P: Turkish plots flip with the window's start year |
| D17 | **A single judgement rejects for good** (kind "no" with no second family) | `engine.mjs:1918-1924` | 2c6e9c9 (#203) | S: a real supplier disappears from later runs |

**Checked, not assumed (the brief's list).** "The clause vote replaced a concept" is confirmed with one correction: #202 replaced the model-written checklist of the decision model with a parallel layer instead of extending the decision model (lesson F54), and the gap it tried to close, D1, dates from #20. "Scoping was replacing the domain and concept stages" is confirmed as a plan (`engine-plan-2026-11-17.md:18`) and as D9; on main the domain and concept stages still run. "#205 lets Hints skip the concept pause" is confirmed (`:1007-1011`), and the same bypass has existed for the purpose pause since 0afc298. "67ef503 made the named-example check a score" is confirmed (`verdict.mjs:179`). "Examples as optional or as words" is confirmed in three places (D4). "The kind lost the qualifiers" is confirmed and dated before the purpose work: the stored model of 2026-11-05 already says "wholesale clothing provider".

## 5. Every merged change since #190

"Away" means: moved the engine away from concept first.

| PR | What it changed | Away? | Why, with the line |
|---|---|---|---|
| #190 purpose-decomposition | Semantic layer, scoping, purpose tree, sentence-id judge, kind as a selection | No, with one gap | Gave the engine closed votes and sentence ids, which the concept needs. The tree starts from clauses (`purpose.mjs:170-181`), not from a concept: the root of D2 |
| #191 verdict-integrity | Count, score and memo from the final verdict | No | — |
| #192 deeper-budget | Deeper reads ordered and capped | No | — |
| #193 purpose-replay-findings | Numbers leave goal text | No | — |
| #194 purpose-structure | Requirements grouped by meaning; value and cost sides; tensions | Partly | A requirement is still a comma piece; the grouping prompt says "a list of examples of one thing is one requirement" (`purpose.mjs:113`) but nothing marks the examples or names the thing |
| #195 router-visible-waits | Router log | No | — |
| #196 scoping-coverage | Sources screened against "what the requirements mean"; coverage invariant | Toward, unused | `screeningSubject` (`scoping.mjs:222`) is the right idea; the live wiring passes it the piece questions (D9) |
| #199 audits and plan | Documents | Away, as a plan | Wave 3 deletes "the five legacy scoping stages", among them the domain study and the concept validation (D9) |
| #200 supplier-zero-valid | Judged on the item's own page; a quoted kind "yes" satisfies the kind purpose check | Partly | `judgedAsAskedKind` (`verdict.mjs:6-12`) lets the degraded kind stand in for the purpose check |
| #201 supplier-sites | Own website delivered; "two kind terms admit a supplier page" | Away | D11 (`acceptance.mjs:536-537`) |
| #202 purpose-live | Tree drives the live checklist; hardness vote; uncovered clauses become goals; names never veto | **Away, the largest step** | D2, D4, D7, D9, D13, D14 |
| #203 kind-precision | Second opinion on a kind "no" | Partly | D17 |
| #204 supplier-pool | Hub rounds until the pool is large | Away | D8: a larger pool found with the same degraded kind; snowball queries from "accepted" suppliers that were never eligible |
| #205 concept-pause | Hints skip the concept pause; soft goals leave the score | Away | D10, D15 |
| #206 entity-kind | Kind options for businesses | Away | D3: "whatever range of goods it shows" |
| #207 plot-trend-eur | Trend in EUR over several years | No, but it moves a veto that should rank | D16 |
| #208 measurement | Votes count independent families; `agreed()`; a comma is a proposed cut | Toward | Gives the votes the concept needs. It does not frame a concept |

## 6. What the result screen shows

`public/index.html:1637` prints `acceptanceResult.checks`: "At least N valid items", "Links open a real page", "Value within …", the lexical "Page mentions one of …" or "Page shows the asked …", and one "Checklist: …" row per hard goal (on b2f5b7: only "kind"). `:1644` prints a table of title, value and link. It does not show the eligibility criteria, the share of items meeting each, a tier per item, or a quote. The asker's requirements appear only in the log line "not modelled".

## 7. What Phase 2 restores

**Corrected 2026-11-18 (the owner):** nothing below is a new layer. R1 and R3 extend the decision model: `DecisionModeler.build` frames the request and the expected result, keeps the measured criteria as they are, and stores every requirement no measure covers as a criterion judged by meaning (`decisionModel.requirements`, with the kind in the asker's words in `decisionModel.kind.asked`). There is no `project.concept`. R2 feeds the domain study's findings to the brief (so to `decomposePrompt`) and to the judge.

One commit per row. Engine mechanics only: nothing below names a site, a trade word or a research.

| # | Stage restored | Fixes | Mechanism, reusing what exists |
|---|---|---|---|
| R1 | Concept framing | D1, D3, D14 | `concept.mjs`: three samples frame population, concept elements (with the examples named inside them), context, ranks and method, each with a quote that code finds in the asker's words; an element is kept when two samples quote the same words; a requirement piece no sample covers becomes a concept element by default. The kind label is built by code from the population's and the elements' own words. Stored as `project.concept` |
| R2 | Domain study from the examples | D4, D5, D6, D9 | `domain.mjs`: queries start from the examples and the population; two new aspects, `members` (another member of the class, named in a quoted sentence next to one of the asker's examples, kept when two hosts name it) and `evidence` (what a page of an eligible item shows, tied to a criterion id); case words leave both prompts; scoping is given the concept as its subject |
| R3 | Eligibility criteria fixed from concept and domain | D2, D7, D13 | `decision.mjs`: the checklist is the concept's criteria, each with its quote, anchors and evidence statements; limits stay code checks; tree questions hang under the criterion their clause belongs to and never veto. `voteHardness` is removed. A research whose table measures a criterion answers it from the row |
| R4 | Calibration on real candidates, and the owner's labels | D8, D10 | `validateConcept` becomes calibration for every list research: a sample of real candidates is screened by two families; a criterion on which they split on a real candidate is unsettled, and the research pauses in `needs-concept` with those candidates as examples to label. Labels are stored and shown to the judge. Hints no longer skip it |
| R5 | Screening by meaning | D11, D12, D17 | `ChecklistJudge` gets the embedder; one closed vote per criterion with sentence ids, anchors and labelled examples; a "no" needs two families; the row's measured facts are sentences the judge can quote |
| R6 | Verdict and ranking of the eligible | D13, D16 | `verdict.mjs`: eligible = every criterion "yes" with a quote; unknown = to confirm; ranks order the eligible |
| R7 | The result screen | D15 | Each criterion with its role and share; each item with its tier and the quote per criterion |
