# Audit: find-appropriate-plots-to-buy-fo-b7772e

Date: 2026-11-11
Project id: find-appropriate-plots-to-buy-fo-b7772e
App under audit: free-research-llm (live API on 127.0.0.1:4600)
Scope: read-only live audit of the stored research result. No source changes were made.

## 1. Question (as returned by the API)

> Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike

## 2. Stored acceptance criteria (what the app was asked to deliver)

- acceptance.expected: "50 Plots In EU, Vietnam and Turkey strongly feasible for Glamping business 10 minth, 1 year"
- acceptance.itemCount: 50, urlsLive: false, valueRange: [0, 20000], unit: "EUR", mustMention: []
- constraints: location "Spain, Portugal, Turkey", budget "20000", horizon "1 year"
- brief.foundation.criteria (stored per-listing checks): kind (a plot of land for sale), price (within budget), region (named countries), sea (within an e-bike ride), season (camping months), noAc (mild, no air conditioning), trend, entry, units, demand, legal

## 3. Acceptance result for the project

- acceptanceResult.score: 1
- checks:
  - id `count`, label "At least 50 valid items", value 1, passed true, detail "75 of 201 delivered pass every check; first 75 inspected (a single listing page that opens, price in range)"
  - id `range`, label "Value within 0–20000 EUR", value 1, passed true, detail "75 of 75 pages show a value in range"
  - id `purpose-kind`, label "Page shows the asked plot (your words)", value 1, passed true, detail "75 of 75 delivered pages show it"

## 4. Counts

- Asked for: 50 plots (acceptance.itemCount: 50).
- Kept (delivered) rows in report.deliverables: 201.
- Domains among delivered rows: imovirtual.com 184 (Portugal), pisos.com 17 (Spain).
- Stored value range of delivered rows: 4,900–20,000 EUR; rows outside [0, 20000]: 0.
- Sampled rows: 20 (10 Portugal + 10 Spain, spread across the delivered list).

## 5. Per-sampled-row audit

Sampling: 20 delivered rows spread across both countries — 10 imovirtual.com (Portugal) rows at delivered indices 0, 24, 41, 58, 78, 105, 139, 174, 190, 197 and 10 pisos.com (Spain) rows at indices 62, 67, 104, 127, 129, 157, 185, 191, 194, 200, i.e. spread over the full 201-row delivered list. Each row: link check via `curl -sL -o /dev/null -w '%{http_code} %{url_effective}'`, then the page body fetched and checked for listing kind (land plot, not a house, not a category/search page), price vs the asked 0–20,000 EUR range, and area/location vs the stored criteria. Sea-within-ebike-ride, season and no-AC criteria are computed from coordinates by the app and are not stated on the listing pages; where not visible on the page they are marked unverified.

Link-check note: all 10 pisos.com URLs return `200` with the plain command. All 10 imovirtual.com URLs return `403` with the plain command (bot protection) and `200` with a browser User-Agent; the 403 is a bot block, not a dead link, and the page itself opens fine.

| # | Ctry | Delivered index | Title (as delivered) | URL | Stored value | Link check | Page kind | Page price | Page area | Page location | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | PT | 0 | Terreno Agrícola Novo em Paião, Figueira da Foz | https://www.imovirtual.com/pt/anuncio/terreno-agricola-novo-em-paiao-figueira-da-foz-ID1j2CF | 4,900 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 4,900 EUR ✓ in range | 1,323 m² | Paião, Figueira da Foz, Coimbra, Portugal | ok |
| 2 | PT | 24 | Terreno Florestal em Marinha das Ondas, Figueira da Foz | https://www.imovirtual.com/pt/anuncio/terreno-florestal-em-marinha-das-ondas-figueira-da-foz-ID1j2Ap | 6,900 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 6,900 EUR ✓ | 3,788 m² | Marinha das Ondas, Figueira da Foz, Coimbra, PT | ok |
| 3 | PT | 41 | Terreno Rústico em Paião, Figueira da Foz | https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX | 7,900 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 7,900 EUR ✓ | 2,321 m² | Paião, Figueira da Foz, Coimbra, PT | ok |
| 4 | PT | 58 | Urban land/Land em Faro, Vila Do Bispo REF:1383 | https://www.imovirtual.com/pt/anuncio/urban-land-land-em-faro-vila-do-bispo-ref1383-ID14fUW | 9,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (urban land) | 9,000 EUR ✓ | 5,000 m² | Vila do Bispo e Raposeira, Faro, PT | ok |
| 5 | PT | 78 | Lote de Terreno Rústico no Serro dos Passarinhos, Loulé, Algarve | https://www.imovirtual.com/pt/anuncio/lote-de-terreno-rustico-no-serro-dos-passarinhos-loule-algarve-ID1gc6a | 10,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 10,000 EUR ✓ | 703 m² | Querença, Tôr e Benafim, Loulé, Faro, PT | ok |
| 6 | PT | 105 | Terreno Rústico com 3.640 m² em Usseira, Óbidos | https://www.imovirtual.com/pt/anuncio/terreno-rustico-com-3-640-m-em-usseira-obidos-ID1j5an | 10,500 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 10,500 EUR ✓ | 3,640 m² | Usseira, Óbidos, Leiria, PT | ok |
| 7 | PT | 139 | Oportunidade excecional: Magnífico terreno rústico em Anta - Espinho | https://www.imovirtual.com/pt/anuncio/oportunidade-excecional-magnifico-terreno-rustico-em-anta-espinho-ID1bOss | 13,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (land) | 13,000 EUR ✓ | 1,470 m² | Anta e Guetim, Espinho, Aveiro, PT | ok |
| 8 | PT | 174 | Terreno com 2400 m2 e vista mar | https://www.imovirtual.com/pt/anuncio/terreno-com-2400-m2-e-vista-mar-ID12zaB | 15,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (land, sea view) | 15,000 EUR ✓ | 2,400 m² | Boliqueime, Loulé, Faro, PT | ok |
| 9 | PT | 190 | Terreno rustico com vista mar Estoi | https://www.imovirtual.com/pt/anuncio/terreno-rustico-com-vista-mar-estoi-ID1hbRU | 18,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (land, sea view) | 18,000 EUR ✓ | 2,260 m² | Conceição e Estoi, Faro, PT | ok |
| 10 | PT | 197 | Terreno a 100 metros da Praia Marinhas Esposende | https://www.imovirtual.com/pt/anuncio/terreno-a-100-metros-da-praia-marinhas-esposende-ID1gDy8 | 20,000 EUR | 403 plain / 200 UA | "Terreno para comprar" (land, 100 m from beach) | 20,000 EUR ✓ (at cap) | 800 m² | Esposende, Marinhas e Gandra, Braga, PT | ok |
| 11 | ES | 62 | Terreno en calle La Abadilla | https://www.pisos.com/comprar/terreno-saron-48422526045_518908/ | 9,000 EUR | 200 | category "terrenos", "Terreno en venta" | 9.000 € ✓ | 1,505 m² | Calle La Abadilla, Sarón, Cantabria, Spain | ok |
| 12 | ES | 67 | Terreno en calle Basteira | https://www.pisos.com/comprar/terreno-carino_centro_urbano-55042239472_529391/ | 9,500 EUR | 200 | category "terrenos", "Terreno en venta" | 9.500 € ✓ | 908 m² | Calle Basteira, Cariño, Galicia, Spain | ok |
| 13 | ES | 104 | Terreno en calle Cabanzo, 1 | https://www.pisos.com/comprar/terreno-la_rota_fonegra_cabarzo-53391272668_287500/ | 10,000 EUR | 200 | category "terrenos", "Terreno en venta" | 10.000 € ✓ | 696 m² | Calle Cabanzo 1, La Rota, Cádiz, Spain | ok |
| 14 | ES | 127 | Terreno en calle Figueiroa | https://www.pisos.com/comprar/terreno-figueiroa_carino-53350355501_999170/ | 12,000 EUR | 200 | category "terrenos", "Terreno en venta" | 12.000 € ✓ | 531 m² | Calle Figueiroa, Cariño, Galicia, Spain | ok |
| 15 | ES | 129 | Terreno en Sagunto, Rustica, Cerca de Canet de Berenguer | https://www.pisos.com/comprar/terreno-canet_en_berenguer_centro_urbano-67531378575_524964/ | 12,000 EUR | 200 | category "terrenos", "Terreno en venta" | 12.000 € ✓ | 983 m² | Canet d'en Berenguer, Valencia, Spain | ok |
| 16 | ES | 157 | Terreno en Avenida del Ferrol | https://www.pisos.com/comprar/terreno-pontedeume_centro_urbano-62597778648_104500/ | 13,610 EUR | 200 | category "terrenos", "Terreno en venta" | 13.610 € ✓ | 1,653 m² (page also lists 1.382,65 and 663 m² sub-areas) | Av. del Ferrol, Pontedeume, Galicia, Spain | ok |
| 17 | ES | 185 | Terreno en calle Mouriscal | https://www.pisos.com/comprar/terreno-o_mouriscal-57546221040_527743/ | 15,000 EUR | 200 | category "terrenos", "Terreno en venta" | 15.000 € ✓ | 613 m² (page also lists 293 and 906 m²) | Calle Mouriscal, O Mouriscal, Galicia, Spain | ok |
| 18 | ES | 191 | Terreno en Rebordanes | https://www.pisos.com/comprar/terreno-tui_centro_urbano-85892635177_100800/ | 18,000 EUR | 200 | category "terrenos", "Terreno en venta" | 18.000 € ✓ | 1,800 m² | Rebordanes, Tui, Galicia, Spain (inland, on the Miño river) | ok |
| 19 | ES | 194 | Terreno en calle Barrio de La Llamosa | https://www.pisos.com/comprar/terreno-secadura-39219307216_100900/ | 19,000 EUR | 200 | category "terrenos", "Terreno en venta" | 19.000 € ✓ | 6,787 m² | Barrio de La Llamosa, Secadura, Cantabria, Spain | ok |
| 20 | ES | 200 | Terreno en Carretera 250 | https://www.pisos.com/comprar/terreno-otanes_baltezana_onton-945856909518703_109700/ | 20,000 EUR | 200 | category "terrenos", "Terreno en venta" | 20.000 € ✓ (at cap) | 15,000 m² | Carretera 250, Otañes-Baltezana-Ontón, Cantabria, Spain | ok |

Per-row notes:

- All 20 sampled rows open a real single-listing page for a land plot for sale ("Terreno para comprar" / category "terrenos"); none is a house listing and none is a category/search page.
- Page price equals the stored `value` exactly in all 20 rows, and every value is inside the asked 0–20,000 EUR range (two rows sit exactly at the 20,000 cap: PT #197 and ES #200).
- Area and location read from each page are recorded above. The sea-within-ebike-ride, 10-month season, no-AC and price-trend criteria are computed by the app from coordinates/climate data and are not stated on the listing pages — unverified from the pages themselves (visible only where the title says "vista mar" / "100 metros da Praia" / "Cerca de Canet de Berenguer").
- Row 18 (Tui, Galicia) is an inland plot on the Miño river; whether it meets the "nearby sea or ocean accessible by ebike" criterion is unverified from the page.

## 6. Findings

1. Zero Turkey rows despite Turkey in the stored constraints. `constraints.location` = "Spain, Portugal, Turkey" and `brief.regions` = ["PT","ES","TR","VN"], but all 201 delivered rows are Portugal (imovirtual.com, 184) or Spain (pisos.com, 17) — 0 rows for Turkey (and 0 for Vietnam). `acceptance.expected` even says "50 Plots In EU, Vietnam and Turkey", which contradicts `constraints.location` (Turkey, not Vietnam). Rows showing it: entire report.deliverables set (201 rows, domains imovirtual.com/pisos.com only). Deciding code: `candidateDeliverables` src/research/candidates.mjs:299 and `checkAcceptance` src/research/engine.mjs:1429-1435.
2. Acceptance score 1.0 computed on only 75 of 201 delivered rows. `acceptanceResult.score` = 1 with every check passed, but the count check detail itself says "75 of 201 delivered pass every check; first 75 inspected" — 126 delivered rows were never inspected, because `AcceptanceChecker.evaluate` slices deliverables to `Math.min(MAX_ITEM_CHECKS, Math.ceil(wanted * 1.5))` = ceil(50*1.5) = 75 (src/research/acceptance.mjs:478-479, MAX_ITEM_CHECKS at line 17). A full pass on 37% of the delivered set is reported as score 1.
3. `acceptance.urlsLive: false` — the stored acceptance spec never required live URLs, so "links live" is not part of the score even though the question implies buyable listings; separately, all 10 sampled imovirtual.com rows return HTTP 403 to a plain `curl -sL` (bot protection) and only 200 with a browser User-Agent, so any link-liveness check done without a browser UA would mark every Portuguese row dead. Rows: all 10 sampled PT rows above.
4. report.summary / verdict claim unverified scope. The verdict claims "201 verified plots found that meet the €20,000 budget, mild climate, 10-month season, sea proximity and e-bike accessibility criteria" and the summary says "201 coastal plots across Portugal, Spain, and Turkey", but the delivered rows carry no sea/season/climate evidence fields (only title/url/value/nodeId), none are in Turkey, and my 20-row sample shows the per-row climate/sea criteria are not visible on the listing pages. Deciding code: report assembly in src/report.mjs and deliverables construction in src/research/engine.mjs:1432-1435.
5. Generic duplicate titles make rows indistinguishable: 80 of 201 delivered rows are titled exactly "Terreno para venda" with no location, and several other titles repeat twice (e.g. "Venda de terreno agrícola, Barroselas, Viana do Castelo" ×2, "Terreno Rústico Venda em Cabaços e Fojo Lobal, Ponte de Lima" ×2 — two different URLs ID1h7zh and ID1h7zg). URLs are unique (201/201), so no duplicate-URL defect, but title-based review cannot tell rows apart. Deciding code: `candidateDeliverables` src/research/candidates.mjs:299 (maps only title/url/price from candidates).
6. Sampled rows themselves are clean: all 20 sampled rows are live land-plot listings with page price exactly equal to the stored value and within 0–20,000 EUR; no wrong-kind rows (no houses, no category pages) in the sample.

## 7. Verdict

- The 20 sampled delivered rows (10 PT + 10 ES) all pass the per-row checks: live single land-plot listing pages, prices exactly matching the stored values and within the asked 0–20,000 EUR range, areas and locations consistent with Portugal/Spain.
- The project-level claims do not fully hold up: score 1.0 rests on inspecting only 75 of 201 rows; Turkey (in constraints) has zero delivered rows while Vietnam appears in the expected text; imovirtual.com links 403 to plain curl; and per-row sea/season/climate criteria are not evidenced in the deliverables themselves (unverified from listing pages).
- No source changes made; this audit is read-only. Doc committed only.
