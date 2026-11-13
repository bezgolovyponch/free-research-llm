**The report is not saved: writing `data/audit/LISTINGS.md` was refused (file writes in this session need an approval that was not granted), so the full report is below instead.** Approve the write and I will save it unchanged. The only thing I created is an empty `data/audit/scratch/` directory.

# LISTINGS audit, 2026-11-12

Scope: listings and the result table (`candidates.mjs`, `itemgate.mjs`, `acceptance.mjs`, `site.mjs`, `parcels.mjs`, `listings.mjs`, `search.mjs`, `portals.mjs`, `sweep.mjs`, and the table functions of `engine.mjs`).

How it was checked: read-only inline `node -e` one-offs against `data/projects/*.json` and `data/sites.json`. No network calls were made and no file was changed. Where a replay needed exchange rates I assumed 24.3 CZK, 4.25 PLN and 55.9 TRY per EUR. With those, rebuilding the car table gave 209 kept / 2,542 to check / 506 screened, against the stored 205 / 2,546 / 506 (the 4 moved by the distance check).

Short names: 0c750f = hatchback cars around Prague, b7772e = glamping plots, b2f5b7 = clothing suppliers.

### LISTINGS-1. The acceptance kind check is waived for every swept row, so an engine sold alone is result #1 and passes every check
- class: definite bug
- severity: high
- where: `src/research/acceptance.mjs:230` (`purposePass`)
- evidence: `if (item?.harvested && item?.nodeId === 'sweep') return true;`. Verified by running on 0c750f:
  - All 30 inspected items are `nodeId: "sweep"`, `harvested: true`, so "purpose-kind: 30 of 30 delivered pages show it" was decided without reading a page.
  - Item 1 is `Motor dacia sandero` (https://auto.bazos.cz/inzerat/225314130/motor-dacia-sandero.php, 25,000 CZK), an engine, stored with `live: true, listing: true, inRange: true` and purpose-kind passed.
  - It is also row 1 of the table (`underpriced: 2.37`). The stored kind has `not: ["parts","accessories","kola"]` only, so nothing upstream stops it.
- impact: the expected result shows 100% while the top "car" is a part. A14's catch (`calibrateKind`, `implausiblyLow`) no longer holds for this row.
- fix: drop the waiver; run `kindOnPage` or the subtype title check on swept rows like any other item, and fail the check when the title carries a `kind.not` or part word.
- test: `purposePass fails a swept row that is a part`, input title `Motor dacia sandero`, `nodeId: 'sweep'`, `harvested: true`; expect `passed: false`.
- confidence: 0.9

### LISTINGS-2. A model-voted list of 16 model names is used as a closed whitelist: 2,454 of 3,257 car rows go to "to check"
- class: design flaw
- severity: high
- where: `src/research/candidates.mjs:176-180` (`screenCandidate`)
- evidence: ``if (!subtype.models.some((model) => hasWord(offer, model))) missing.push(`not shown to be a ${subtype.label}`);``. Verified by running on 0c750f:
  - Of 2,480 to-check rows, 2,454 carry "not shown to be a hatchback".
  - The stored list is `kia rio, citroen c3, honda civic, peugeot 207, hyundai i10, kia picanto, ford fiesta, prodam citroen c1, prodam citroen, honda jazz, dacia sandero, toyota yaris, seat ibiza, skoda fabia ii, skoda fabia, skoda felicia`.
  - Rows whose only gap is this list include Opel Astra 37, Opel Corsa 28, Seat Leon 21, Peugeot 206 18, Renault Clio 14, Kia Ceed 14, VW/Volkswagen Golf 19, Hyundai i30 9, Suzuki Swift 8, Volkswagen Polo 6, Citroen C1 6.
  - Two entries contain the seller verb "prodam" ("I sell"), so `Prodám Citroen C4 1,4 + LPG` is kept while a plain `Citroen C1` is not.
- impact: three quarters of the market never reaches the table or the valuation; of the 205 kept rows, 203 come from one portal, and only the 16 listed names can be kept.
- fix: treat the list as evidence for a row, not against it. A row with no listed model stays a candidate marked "body type not confirmed" and is confirmed from the listing page. Strip leading verbs such as `prodam` in `applyCalibration`.
- test: `screenCandidate keeps a row whose model is not in the list`, input title `Opel Corsa 1.2`, brief subtype as stored; expect no "not shown to be" in `missing`.
- confidence: 0.8

### LISTINGS-3. The headline says 273 plots fit while 266 count, and "332 confirmed" mixes tiers
- class: definite bug
- severity: high
- where: `src/research/candidates.mjs:335-340` (`tableVerdict`), `src/research/verification.mjs:35-37` (`applyVerification`)
- evidence: `const fits = t.fits ?? 0;` feeds the sentence, while `keptCount` is fits ∧ confirmed and `confirmed = verdicts('confirmed')` counts every verifiable tier. Verified by running on b7772e:
  - The verdict reads "273 results of the 50 asked fit every check (externally verified: 332 confirmed, 496 refuted, 54 not yet confirmed …)".
  - Stored `keptCount` is 266, fits ∧ confirmed is 266, and 66 confirmed rows are not fits.
  - Found 2,950 ≠ 266 kept + 218 to check + 1,279 screened out, because `keptCount` is overwritten and `screenedCount` is not.
- impact: this is A1 again (headline larger than what counts), and the table counts no longer add up (A15).
- fix: build the sentence from `candidates.keptCount`, count confirmed, refuted and unconfirmed among fits only, and report other tiers separately. Keep a separate count of rows kept so the totals still add up.
- test: `tableVerdict reports fits ∧ confirmed`, input the stored b7772e `candidates`; expect "266 results" and no number above 273 in the verified clause.
- confidence: 0.9

### LISTINGS-4. The to-check list is cut to 100 rows before it is stored: 2,442 car rows exist nowhere
- class: design flaw
- severity: medium
- where: `src/research/candidates.mjs:283` (`buildCandidates`), `src/research/engine.mjs:472` (`measureDistances`)
- evidence: `toCheck: toCheck.slice(0, MAX_TO_CHECK)`. Verified by running on 0c750f: `toCheckCount` is 2,546 and 104 rows are stored. `measureDistances` reads `table.toCheck` after the cut, so only those rows get a distance. This is separate from the known `MAX_KEPT` cut.
- impact: the user is told 2,546 rows need a check and can open or export 104. With LISTINGS-2, most of the market is unreachable.
- fix: store every to-check row (or page them), grouped by reason, and cut only what is shown.
- test: `buildCandidates keeps every to-check row`, input the 0c750f sweep pages; expect `toCheck.length === toCheckCount`.
- confidence: 0.85

### LISTINGS-5. Merging two extraction methods pairs one method's area with the other's unit: 6,500 m² becomes 6,500 ha
- class: definite bug
- severity: medium
- where: `src/search/listings.mjs:424` (`merge`)
- evidence: `for (const key of ['value', 'unit', 'area', 'areaUnit', 'place', 'card']) if ((known[key] === null || known[key] === '' || known[key] === undefined) && item[key] !== undefined) known[key] = item[key];`. Each field is filled on its own. Verified on b7772e:
  - Listing `…/terreno-rustico-de-0-65ha-localizado-a-cerca-de-250mt-da-localidade-ID1aYKL` has `attrs.areaInSquareMeters: 6500` and `via: ["embedded-json","cards"]`, and is stored as `area: 6500, areaUnit: "ha"`.
  - Its units check reads "65,000,000 m² → 30 units".
  - Same pattern: `18500 ha` for a 1.85 ha plot, `8000 ha` for 0.8 ha, `40820 dönüm` on emlakjet. 13 imovirtual sweep listings carry ha/hectare units.
- impact: wrong area in the table and export, wrong price per m² (which feeds the low-outlier rule), and the "room for 3 units" check passes on invented land.
- fix: fill `area` and `areaUnit` together, only when the known row has no area.
- test: `merge keeps area and unit from one method`, input the embedded-json record (6500, no unit) and the card (0.65, ha) of that listing; expect 6500 m².
- confidence: 0.9

### LISTINGS-6. Seed portals are dropped by comparing a EUR cap with the user's number in any currency, and by a fixed 20,000 in the URL
- class: definite bug
- severity: medium
- where: `src/research/portals.mjs:72` (`seedPortals`), `:9` and `:11`
- evidence: `(p.maxPrice === null || max === null || p.maxPrice >= max)`; `max` is in the brief's unit, `p.maxPrice` is EUR. Verified by running with the b7772e brief:
  - As stored (0–20,000 EUR): ES 8, TR 11, PT 10 seeds.
  - Same limit written as 0–486,000 CZK: TR 11 only.
  - Limit 25,000 EUR: TR 11 only, because `hasta-20000` and `priceMax=20000` are fixed in the URLs.
- impact: a user who states the budget in CZK, or one euro above 20,000, gets no Spanish or Portuguese portal and no message saying why.
- fix: convert `max` to `p.currency` before comparing, and build the pisos and imovirtual URLs from the converted maximum.
- test: `seedPortals keeps ES and PT for a CZK budget`, input the b7772e brief with `valueRange [0, 486000]`, `unit 'CZK'`; expect 8 ES and 10 PT seeds.
- confidence: 0.9

### LISTINGS-7. When exchange rates cannot be fetched, every foreign-currency listing is screened out as "price outside"
- class: likely bug
- severity: medium
- where: `src/research/itemgate.mjs:64-65` (`screenItem`), `src/research/rates.mjs:42,49`, `src/research/candidates.mjs:150-156`
- evidence: ``if (value === null || value < valueRange[0] || value > valueRange[1]) reasons.push(`price ${raw} … is outside …`)``; the converter returns `null` for an unknown currency and `rates()` falls back to `{ EUR: 1 }`. Verified by running with a converter that has no rates, on the kept row "9 Adet Zeytin Ağacı Olan" (290,000 TRY, stored as €5,189): reasons `["price 290000 TRY is outside 0–20000 EUR"]` and missing `["price not shown"]`. Related: a row with no currency is assumed to be in the asked one; the muaban.net rows of b7772e are labelled "price 8200000000 EUR".
- impact: one failed rate fetch removes all 255 Turkish rows (or every non-CZK car) with a false reason, and nothing is logged.
- fix: when conversion returns null, add no reason; put the row in to-check with "price in TRY, no exchange rate" and emit a warning.
- test: `screenItem does not reject when the rate is unknown`, input value 290000, unit TRY, range 0–20000 EUR, `convert: () => null`; expect no price reason.
- confidence: 0.75

### LISTINGS-8. Different bazos ads share one dedupe key when their titles end in the same number
- class: definite bug
- severity: medium
- where: `src/search/listings.mjs:402-408` (`listingKey`), used at `candidates.mjs:244-247` and `sweep.mjs:112`
- evidence: `const LISTING_ID = /(?:ID[A-Za-z0-9]{4,}|[a-z]?\d{4,})/g;` and `ids[ids.length - 1]`: the last digit run wins, not the ad id. Verified by running on 0c750f:
  - 3,273 URLs give 3,257 keys; 13 keys collide and 16 ads are lost.
  - Example key `auto.bazos.cz#2004`: `…/225780289/skoda-fabia-12-htp-2004.php` and `…/225619567/skoda-octavia-2004.php`.
  - Other keys: `#2012`, `#14999` (a price), `#180000` (a mileage).
  - By reading: when the first row has no price, line 247 merges the two into one row with one ad's title and the other's price and URL.
- impact: listings vanish before screening, and a merged row can show a wrong price. It grows with every ad whose slug ends in a year.
- fix: prefer the first long id in the path (6+ digits or `ID…`); fall back to the full path.
- test: `listingKey separates two bazos ads ending in 2004`, the two URLs above; expect different keys.
- confidence: 0.9

### LISTINGS-9. A page the site refused or removed is fetched again through the Jina reader
- class: likely bug
- severity: medium
- where: `src/search/search.mjs:388-395` (`readRaw`), `:350` (`fetchPage`)
- evidence: by reading: `if (this.jinaReader && !(direct.text.length >= 400 && !this.recipes?.get(url)))` has no status test. A direct 401, 403, 429, 404 or 410 (text `''`) therefore goes on to `https://r.jina.ai/<url>`, and `best = { ...viaReader }` takes the reader's own status. CONCEPT says such a site "is left alone", and E5 says never. The gone rule (`GONE_STATUS`, `site.mjs:466`) only sees the status of the winning read. Supporting data, not proof: `data/sites.json` holds 2,000 page facts and 1 marked gone, and the b7772e log never prints "listing removed from the portal". Not run against the network.
- impact: refusals are worked around through a third party, and removed listings can stay in the table as live.
- fix: return `direct` at once when its status is 401, 403, 404, 410 or 429.
- test: `readRaw does not call the reader after 403 or 404`, stub fetch returning 403 for a pisos.com listing URL from the sweep; expect one fetch call and the status kept.
- confidence: 0.6

### LISTINGS-10. The price-in-range check compares an unconverted listing price with the asked range when the page shows no amount
- class: definite bug
- severity: low
- where: `src/research/acceptance.mjs:396` (`inRange`)
- evidence: `if (!headline) return itemValue !== null && … Number(itemValue) >= min && Number(itemValue) <= max;` with no currency. Verified by running: range 0–20,000 EUR, item 15,000 TRY (about €270) returns `true` unconverted; by the same line (by reading) a 19,000 CZK price passes a 20,000 EUR limit. When the page does show amounts, the first one on the page wins over the listing's own structured price (by reading).
- impact: a wrong pass or fail of the range check for non-EUR rows (A5).
- fix: pass the item's unit and convert it; prefer the structured price when the row has one.
- test: `inRange converts the item value`, item 15000 CZK, range 0–500 EUR, no page amounts; expect false (about €617).
- confidence: 0.8

### LISTINGS-11. The pitch count ignores the area unit: a 4 dönüm plot shows "~0 pitches"
- class: definite bug
- severity: low
- where: `src/research/site.mjs:183` (`fitOf`), `:140-144` (`pitchesFor`); shown at `public/index.html:1427`
- evidence: `pitches: pitchesFor(row.area)`, while `strategy.mjs:204` (`areaM2`) converts ha, acres and dönüm. Verified on b7772e: the kept row "Balcity - Çanakkale | Biga Güleç Mahallesinde 4 Dö…" has `fit.pitches: 0`, and its plan check says "4,000 m² → 30 units".
- impact: the row's detail line contradicts its own units check.
- fix: `pitchesFor(areaM2(row))`.
- test: `fitOf converts dönüm`, input `area 4`, `areaUnit 'dönüm'`; expect 30.
- confidence: 0.9

### LISTINGS-12. Forum comments are read as listings: the only Vietnam row is a post dated "1/7/26"
- class: likely bug
- severity: low
- where: `src/search/listings.mjs:374-399` (`fromCards`), `src/research/acceptance.mjs:410` (`PATH_ID`)
- evidence: verified on b7772e: voz.vn thread pages yield 48 "listings" whose titles are post dates (`5/3/24`, `1/7/26`) and whose price is a number in the comment. `screenCandidate` on the `1/7/26` row (200,000,000 VND, card "…do luật pháp nên bắt buộc chia như vậy…") returns no reasons and no gaps, value €6,667. It is in the kept table as the one VN row, tier blocked.
- impact: Vietnam looks covered by one plot that is a forum comment (A7).
- fix: require a title with at least two letter words, and drop card groups where most titles are dates.
- test: `fromCards drops date-only titles`, the stored voz.vn rows; expect none.
- confidence: 0.7

### LISTINGS-13. Rows whose distance cannot be measured stay kept and count
- class: design flaw
- severity: low
- where: `src/research/engine.mjs:514-518` (`measureDistances`)
- evidence: by reading: `row.unmeasured = true; unmeasured++;` and no other file reads `unmeasured` (grep over `src/` and `public/index.html`). The row stays in `kept` and goes to `candidateDeliverables`. On 0c750f all 205 kept rows have a distance today, so the stored data does not show it.
- impact: a listing with no stated place would count toward "within 300 km of Prague" without that check (A2).
- fix: move unmeasured rows to to-check with "distance not measured".
- test: `measureDistances moves a row without a place to to-check`, a kept 0c750f row with `place` removed.
- confidence: 0.6

### LISTINGS-14. The parcel lookup reads listing pages with a Safari User-Agent and outside the shared page cache
- class: uncertainty
- severity: low
- where: `src/research/parcels.mjs:7,102,128`
- evidence: by reading: `const BROWSER_AGENT = 'Mozilla/5.0 (Macintosh; …Safari/605.1.15'` is sent by `http()` to both the TKGM service and `row.url` (`listingParcel(await this.fetchText(row.url))`). Every other read identifies itself as `free-research-llm/1.0` and goes through `SearchService.readPage`.
- impact: possible conflict with E5 and with "One page cache"; each Turkish listing is fetched twice. I could not tell whether TKGM requires a browser agent.
- fix: read the listing through `search.readPage`; keep the browser agent only for TKGM if its terms allow.
- test: `ParcelRegistry reads the listing through the injected page reader`.
- confidence: 0.4

## Summary
- Counts: definite bug 7 (1, 3, 5, 6, 8, 10, 11), likely bug 3 (7, 9, 12), design flaw 3 (2, 4, 13), uncertainty 1 (14).
- Most damaging: LISTINGS-1 together with LISTINGS-2. The car research reports 100% while its first result is an engine, and 2,454 real cars sit in a to-check list of which about 100 are stored.
- Not checked: live network behaviour (the Jina reader's status for refused or removed pages, LISTINGS-9), the UI beyond one grep, the external verifier, `cadastral.mjs`, and the sweep page budget under live paging. Replays that convert currency used my assumed rates, not the app's.