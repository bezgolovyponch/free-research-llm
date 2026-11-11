# Audit: find-the-wholesale-branded-secon-b2f5b7

Date: 2026-11-11
Project id: find-the-wholesale-branded-secon-b2f5b7
App under audit: free-research-llm (live API on 127.0.0.1:4600)
Scope: read-only live audit of the stored research result. No source changes were made before the fix in step 4.

## 1. Question (as returned by the API)

> Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic

## 2. Stored acceptance criteria (what the app was asked to deliver)

- expected: "20 direct links to the providers with proposal and proof that those particular companies do have highest proce/value ratio, quality, assortiment and appropriate setup for local Prague branded second hand shop retail"
- successCriteria: "Identify 20 suppliers meeting price/value, quality, assortment, and Czech operational criteria"
- acceptance.itemCount: 20, urlsLive: true, valueRange: null, mustMention: []

## 3. Acceptance result for the project

- acceptanceResult.score: 0.181
- checks:
  - id `count`, label "At least 20 valid items", value 0.05, passed false, detail "1 of 7 delivered pass every check; first 7 inspected (a single listing page that opens and describes the asked kind"
  - id `live`, label "Links open a real page", value 0.35, passed false, detail "7 of 7 checked links are live" (7 checked against a target denominator of 20)
  - id `purpose-names-1`, label "Page mentions one of: ... (your words)", value 0.143, passed false, detail "1 of 7 delivered pages show it"

## 4. Counts

- Asked for: 20 direct wholesale supplier links.
- Kept (delivered) rows in report.deliverables: 7.
- Sampled rows: 7 (all delivered rows, within the up to 30 sample cap).
- Rows passing every acceptance check: 1 of 7 delivered.
- Duplicates by domain among delivered rows: none (7 distinct domains).

## 5. Per-sampled-row audit

| # | Deliverable title | URL | Evidence | nodeId | Wholesale B2B (bulk/bales/lots)? | Asked brands plausibly carried (quote) | Link check | Verdict |
|---|---|---|---|---|---|---|---|

### Row 1 - accio.com

- deliverable: "Germany Wholesaler Used Clothes: Top Suppliers & Bulk Deals"
- url: https://accio.com/ -> final 200
- evidence: https://www.accio.com/supplier/germany-wholesaler-used-clothes -> final 200
- wholesale B2B: WRONG. accio.com is an AI-agents platform surface; the source page is an Accio "supplier" resource reporting "Results from 138900+ products and 3500+ suppliers". Marketplace/directory style, not a supplier.
- brands: not found.
- link opens: ok (200)
- verdict: wrong - not a wholesale supplier.

### Row 2 - apparelsearch.com

- deliverable: "Wholesale Used Clothing"
- url: https://apparelsearch.com/wholesale_clothing/wholesale_used_clothing.htm -> final 200
- evidence: same page -> 200
- wholesale B2B: wrong - "Used Clothing Wholesaler Directory"; the site points at processors "who collect, sort into hundreds of categories, bale and ship secondhand clothing by the container". Directory of wholesalers, not a supplier.
- brands: not found.
- link opens: ok (200)
- verdict: wrong - directory listing, not a supplier.

### Row 3 - usfripe.com

- deliverable: "Where to Buy Vintage Clothing Wholesale in Europe (2026 Guide)"
- url: https://usfripe.com/blogs/news/where-to-buy-vintage-clothing-wholesale-in-europe-2026-guide -> final 200
- evidence: same -> 200
- wholesale B2B: wrong - blog/guide page ("2026 Guide", "FREE SHIPPING ON ORDERS 2000EUR", "NEXT DAY DISPATCH"); explicitly listed as an excluded category in brief.excludes.
- brands: not found.
- link opens: ok (200)
- verdict: wrong - blog/guide, excluded category.

### Row 4 - zagumi.com

- deliverable: "Groothandel gebruikte kleding in balen - Zagumi"
- url: https://zagumi.com/nl/used-clothing/ -> final 200
- evidence: https://www.zagumi.com/nl/used-clothing/ -> final 200
- wholesale B2B: ok - "Groothandel gebruikte kleding in balen", "Import per kg, pond, container", "Crème kwaliteit". Real B2B wholesale of used clothing in bales.
- brands: not found by exact-word check (page uses "merkkleding"/branded wording).
- link opens: ok (200)
- verdict: ok - real B2B wholesaler, brands not explicitly documented.

### Row 5 - excellent-vintage.com

- deliverable: "Vintage Wholesale Clothing Netherlands: Complete Guide 2026"
- url: https://www.excellent-vintage.com/en/blog/complete-guide-vintage-wholesale-clothing-netherlands-2026 -> final 200
- evidence: same -> 200
- wholesale B2B: ok at the business level (Excellent Vintage Wholesale Warehouse, bales/bundles by weight) - but delivered via a blog guide page.
- brands: ok - quote: "Think a hundred Ralph Lauren shorts, a hundred Tommy sweaters, or two hundred Ralph Lauren shirts. That count is the honest figure..."
- link opens: ok (200)
- verdict: ok supplier but delivered through an excluded blog/guide page.

### Row 6 - wiltex.eu

- deliverable: "Second-Hand Clothing Importer - Wiltex Wholesale"
- url: https://wiltex.eu/second-hand-clothing/ -> final 200
- evidence: same -> 200
- wholesale B2B: ok - second-hand clothing wholesaler with A/B grade classes and container/bale sourcing.
- brands: not found.
- link opens: ok (200)
- verdict: ok supplier, brands not documented.

### Row 7 - recyclingitaly.com

- deliverable: "Wholesale Second Hand Clothes in Germany for B2B"
- url: https://recyclingitaly.com/blog/wholesale-second-hand-clothes-in-germany-for-b2b -> final 200
- evidence: same -> 200
- wholesale B2B: ok at the business level (bales/bulk stock) - but delivered via a blog post.
- brands: not found.
- link opens: ok (200)
- verdict: ok supplier but delivered through a blog post.

## 6. Distinct failure patterns (with affected row counts and deciding src code)

### Pattern 1 - Blog / guide / news pages delivered as wholesale suppliers (3 rows)

- Affected rows: delivered #3 (usfripe), #5 (excellent-vintage), #7 (recyclingitaly) = 3 rows.
- Wrong rows among kept set: the delivered rows that are not suppliers at all are #1 accio, #2 apparelsearch, #3 usfripe, #5 excellent-vintage blog, #7 recyclingitaly blog -> more precisely, 3 delivered rows are blog/guide surfaces.
- Deciding code: `entityDeliverables` in src/research/acceptance.mjs; the keep-filter around lines 354-358 (LISTICLE_TITLE title test at line 357, new BLOG_GUIDE_PATH check at line 358) plus directory/marketplace guards at lines 354-356. The function skipped marketplaces/directories/listicles/reviews and non-wholesale shops but had no blog/guide path or "(... Guide)" title rule, so guide pages slipped through even though brief.excludes names "news, blog or guide pages".
- Fix: added `const BLOG_GUIDE_PATH = /\/(?:blog|blogs|guide|guides)\//i;` (src/research/acceptance.mjs:290) and a skip in the keep loop (src/research/acceptance.mjs:358). After the fix the delivered set drops the blog/guide rows.

### Pattern 2 - Directory / marketplace-style pages delivered as suppliers (2 rows)

- Affected rows: delivered #1 accio.com and #2 apparelsearch.com = 2 rows.
- Deciding code: `entityDeliverables` in src/research/acceptance.mjs; marketplace set (KNOWN_B2B_MARKETPLACES, lines 287-288) and directory detection (DIRECTORY_LISTINGS line 283, DIRECTORY_PATHS line 284) around lines 336-347; keep-loop lines 354-366.
- These hosts are not in the fixed marketplace set and do not cross the per-host product-path directory threshold with the harvested single source, so they were kept.

### Pattern 3 - Asked brands not plausibly carried

- Affected rows: 6 of 7 sampled rows show no Ralph Lauren / Monclair / Moncler / North Face / Barbour mention; only 1 of 7 delivered pages passed the purpose-brand check (value 0.143, passed false).
- Deciding code: `purposeChecks` (src/research/acceptance.mjs:176), `purposePass` (src/research/acceptance.mjs:227), and `AcceptanceChecker.evaluate` (src/research/acceptance.mjs:478).

### Pattern 4 - Delivery count short of the asked count

- Affected rows: 7 kept vs 20 asked; valid rows passing all checks = 1.
- Deciding code: `AcceptanceChecker.evaluate` (src/research/acceptance.mjs:478-489), count check at line 486, item slice at line 479.

## 7. Source locations (grep excerpts)

- `grep "entityDeliverables" src/research/acceptance.mjs` -> declared at src/research/acceptance.mjs:307.
- `grep "LISTICLE_TITLE" src/research/acceptance.mjs` -> src/research/acceptance.mjs:288, tested at src/research/acceptance.mjs:357.
- `grep "BLOG_GUIDE_PATH" src/research/acceptance.mjs` -> src/research/acceptance.mjs:290, tested at src/research/acceptance.mjs:358.

## 8. Fix applied (step 4)

- One-function, narrow cause: `entityDeliverables` in src/research/acceptance.mjs kept blog/guide pages.
- Fix: skip sources whose URL path is a blog/guide path (src/research/acceptance.mjs:358, constant at src/research/acceptance.mjs:290).
- No source changes were made before this point.

## 9. Test added / extended

- tests/research/acceptance.test.ts: new case "excludes blog and guide pages even when they carry the asked terms" expecting exactly one deliverable for the supplier page and none for the /blog/ and /blogs/ sources. Confirmed failing before the fix and passing after.

## 10. Commit
