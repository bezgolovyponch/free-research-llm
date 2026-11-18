# Plot price trend in the buyer's currency (2026-11-18)

Plots b7772e: every one of 322 Turkish plots failed "real price trend above the EU average": Turkey -10.7% a year after Turkish inflation (2024) vs EU +2.9%. The user buys in EUR (budget 20000 EUR max).

Method: for each year, (1 + local house price change) × (exchange rate last year / this year) ÷ (1 + euro-area inflation). Exchange rate: Eurostat `ert_bil_eur_a`, `statinfo=AVG`, `currency=<the country's listing currency>`, national currency per euro (TRY 2023 25.7597, 2024 35.5734, 2025 44.8161). Euro countries have factor 1. Base inflation: `prc_hicp_aind`, `geo=EA`. The country's currency is read from its own listings (TR: TRY on all 322 rows; PT, ES, MT: EUR). The check compares growth per year in EUR over the same years for the country and the EU (a trend, not one year); the detail still shows last year in EUR and in local terms.

Live Eurostat output (2026-11-18, `trendOf` on fetched series):

```
TR {"year":"2024","localReal":-10.7,"localCagr":16.6,"eurReal":0.1,"eurCagr":16.7,"since":"2021","fx":-27.6}
PT {"year":"2025","localReal":15.1,"localCagr":7.5,"eurReal":15.2,"eurCagr":6.9,"since":"2021"}
ES {"year":"2025","localReal":9.7,"localCagr":3,"eurReal":10.4,"eurCagr":2.9,"since":"2021"}
EU27_2020 {"year":"2025","localReal":2.9,"localCagr":1,"eurReal":3.3,"eurCagr":0.8,"since":"2021"}
```

So in EUR, Turkey grew +16.7% a year 2021–2024 against the EU's +0.8%; its last year alone was +0.1% in EUR. The store keeps its version (4): only trend entries without the new version are fetched again, so measured places are not lost.
