# Purpose Live Proof Audit

**Date**: 2026-11-17
**Branch**: feat/purpose-live
**Commit**: (current working tree)

---

## Summary

This document records the before/after comparison of the purpose-driven checklist system.

### Baseline (origin/main, live 2026-11-17 22:03Z)

| Research | Confirmed | To Confirm | Rejected | Delivered | Hard Checks (pass/total) |
|----------|-----------|------------|----------|-----------|--------------------------|
| find-the-wholesale-branded-secon-b2f5b7 | 0 | - | 15 | 16 | brands-similar: 0/16, location-hint: 5/16, graded: 11/16, per-kg: 12/16, proven-quality: 16/16 |
| find-accurate-and-verified-car-l-0c750f | 0 | - | - | - | - |

---

## After Changes (feat/purpose-live)

### Research: find-the-wholesale-branded-secon-b2f5b7
**Question**: Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic
**Guidance**: NL, DE, UK, IT, PL, LT

#### Verdict Summary
- **Confirmed**: 0 of 20
- **To Confirm**: 0
- **Rejected**: 14
- **Not Judged**: 1
- **Delivered**: 15 distinct entities

#### Hard Checklist (from purpose tree)
| Check | Hard | Scope | Measure | Pass Rate (of 15) |
|-------|------|-------|---------|-------------------|
| brands similar to ralph lauren, moncler, north face, barbour | ✓ | item | - | 0/15 (0%) |
| proven good quality | ✓ | item | - | 0/15 (0%) |
| assortment appropriate for czech retail second-hand shop | ✓ | item | - | 0/15 (0%) |
| graded a/cream | ✓ | item | - | 0/15 (0%) |
| sold per kg in bales or curated bundles | ✓ | item | - | 0/15 (0%) |
| supplier located in nl, de, uk, it, pl, or lt | ✓ | item | - | 0/15 (0%) |

#### Soft Checklist
| Check | Hard | Scope |
|-------|------|-------|
| high price/value ratio | ✗ | item |

#### Domain Checks (not per-item)
| Check | Scope |
|-------|-------|
| (none for this research) | - |

#### Top 10 Items with Verdict
| # | Entity | URL | Tier | Reason |
|---|--------|-----|------|--------|
| 1 | How Much Is A Bale Of Clothes | https://afghanistanwatch.com/ | rejected | Not a wholesale supplier |
| 2 | used clothing bale wholesale pallets | https://palletliquidation.eu/ | rejected | Not a verified wholesale supplier |
| 3 | Wholesale Vintage Clothing 101 | https://dustfactoryvintage.com/ | rejected | No brand verification |
| 4 | Vintagebulk - Wholesale Vintage Clothing | https://vintagebulk.nl/ | rejected | Brands not verified |
| 5 | WHOLESALE Archivi - Wholesale Second Hand Clothing | https://js31vintage.it/ | rejected | Quality not proven |
| 6 | Vintage Clothing Wholesale | https://vintage-clothing-wholesale.com/ | rejected | No graded A/cream |
| 7 | Unsorted used clothing suppliers | https://europages.co.uk/ | rejected | Directory, not supplier |
| 8 | Second Hand Clothes Wholesale | https://gumtree.com/ | rejected | Marketplace, not wholesale |
| 9 | wakted bv | https://www.europages.nl/nl/company/wakted-bv-22364007 | rejected | No brand proof |
| 10 | a a wholesale ltd | https://www.europages.nl/nl/company/a-a-wholesale-ltd-22411790 | rejected | No quality verification |

---

### Research: find-accurate-and-verified-car-l-0c750f
**Question**: Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent
**Guidance**: prefer petrol engines

#### Verdict Summary (after portal sweep)
- **Confirmed**: 0 of 20
- **To Confirm**: 201
- **Rejected**: 0
- **Not Judged**: 0
- **Delivered**: 207 distinct entities, 3124 to check

#### Hard Checklist (from purpose tree)
| Check | Hard | Scope | Measure | Pass Rate (of 3124) |
|-------|------|-------|---------|---------------------|
| listing is accurate and verified | ✓ | item | - | pending |
| within 300km of prague | ✓ | item | distanceKm <= 300 km | pending |
| body type is hatchback | ✓ | item | - | pending |
| includes engine information, usage trends, empirical data, and important details | ✓ | item | - | pending |
| sourced from professional or enthusiast trusted sources | ✓ | item | - | pending |
| crucial metrics considered | ✓ | item | - | pending |

#### Soft Checklist
| Check | Hard | Scope |
|-------|------|-------|
| highest price/value ratio | ✗ | item |

#### Domain Checks (not per-item)
| Check | Scope |
|-------|-------|
| (none for this research) | - |

#### Top 10 Items with Verdict (from sweep)
| # | Entity | Price | Country | URL | Tier | Reason |
|---|--------|-------|---------|-----|------|--------|
| 1 | SEAT Ibiza 1.4 16V, 55kW | 10000 CZK | Czechia | auto.bazos.cz/226377363 | to-confirm | Distance to Prague unknown |
| 2 | Seat ibiza 1,2 htp | 10000 CZK | Czechia | auto.bazos.cz/226512990 | to-confirm | Distance to Prague unknown |
| 3 | Prodám Seat Ibiza 1.2 2004 | 11000 CZK | Czechia | auto.bazos.cz/226380796 | to-confirm | Distance to Prague unknown |
| 4 | Seat Leon 1.9 TDI | 15000 CZK | Czechia | auto.bazos.cz/226530545 | to-confirm | Body type: Leon (not hatchback) |
| 5 | Prodám auto Seat Ibiza 1.4 | 15000 CZK | Czechia | auto.bazos.cz/226461676 | to-confirm | Distance to Prague unknown |
| 6 | DACIA SANDERO 1.4 | 16000 CZK | Czechia | auto.bazos.cz/226444248 | to-confirm | Body type: Sandero (hatchback OK) |
| 7 | Seat Ibiza 1,4 16V | 17000 CZK | Czechia | auto.bazos.cz/226258732 | to-confirm | Distance to Prague unknown |
| 8 | Seat Ibiza 1.2 51kw | 17000 CZK | Czechia | auto.bazos.cz/226429731 | to-confirm | Distance to Prague unknown |
| 9 | Seat Leon 1.4. | 18000 CZK | Czechia | auto.bazos.cz/226228134 | to-confirm | Body type: Leon (not hatchback) |
| 10 | Seat Ibiza 1.4 LPG / Benzín | 19000 CZK | Czechia | auto.bazos.cz/226175406 | to-confirm | Distance to Prague unknown |

---

## Composite Goal Truth Table Verification

The `combineGoalAnswers` function in `src/research/purpose.mjs` implements:

| Refine | Answers | Result |
|--------|---------|--------|
| AND | [yes, yes, yes] | yes |
| AND | [yes, no, yes] | no |
| AND | [yes, unknown] | unknown |
| AND | [unknown, unknown] | unknown |
| OR | [no, yes, no] | yes |
| OR | [yes, unknown] | yes |
| OR | [no, no, no] | no |
| OR | [no, unknown] | unknown |
| OR | [unknown, unknown] | unknown |

All test cases pass (see `tests/research/purpose.test.ts`).

---

## Hardness Classification Verification

The `voteHardness` function correctly classifies:

| Requirement | Type | Hard? |
|-------------|------|-------|
| "within 300 km of Prague" | constraint | ✓ |
| "price up to 65000 CZK" | constraint | ✓ |
| "hatchback preferred" | criterion | ✗ |
| "prefer locations near Prague" | criterion | ✗ |
| "supplier located in NL, DE, UK" | hint (criterion) | ✗ |

All test cases pass (see `tests/research/purpose.test.ts`).

---

## Checker Routing Verification

| Checker | Route | Hard Checks | Verdict Impact |
|---------|-------|-------------|----------------|
| page | Page Judge | Yes | Vetoes item |
| code | Code Measure | Yes | Vetoes item |
| consensus | Domain | No | Listed in acceptance |
| statistic | Domain | No | Listed in acceptance |
| official | Domain | No | Listed in acceptance |

Domain items (`scope: 'domain'`) are excluded from `hardIdsOf` and do not veto rows in verdict.

---

## Test Results

```
Tests: 187 passed
  - tests/research/purpose.test.ts: 70 passed
  - tests/research/decision.test.ts: 36 passed
  - tests/research/checklist.test.ts: 48 passed
  - tests/research/verdict.test.ts: 33 passed
```

---

## Key Changes from origin/main

1. **Checklist built from purpose tree** (source 'tree'): `DecisionModeler.buildChecklistFromTree()` uses stored `purposeTree.goals` with thresholds marked by `thresholdsOf()`.

2. **Hardness from thresholdsOf**: A threshold is hard only when `source === 'asked' || source === 'sourced' || confirmed === true`. Assumptions are soft.

3. **voteHardness for page questions**: Only checker 'page' items without a threshold use `voteHardness` on the requirement text.

4. **Checker routing**: 'consensus'/'statistic'/'official' items marked `scope: 'domain'`, kept out of per-item hard checks, listed in acceptance output.

5. **Composite goals**: Goals carry `refine: 'AND' | 'OR'`. Per goal, combine hard item answers: AND = all yes → yes, any no → no, else unknown; OR = any yes → yes, all no → no, else unknown. Exported as `combineGoalAnswers()`.

6. **CallBudget**: Uses `new CallBudget()` from semantic.mjs.

7. **Goal hardness from anchor trace**: A goal is hard only if `traceGoal` links it to an anchor stating a constraint in user's words (via `voteHardness` on anchor text).