# Relative Valuation Matrix

An updatable SQLite database for a broad global semiconductor equity universe.

The initial screen contains **100 public companies above $15 billion in market capitalization** and **4 near-threshold watchlist companies** as of September 1, 2026. The market-cap values are screening snapshots rather than live quotes.

## Universe definition

Included businesses cover:

- Fabless chip design and semiconductor IP
- Integrated device manufacturers and memory producers
- Foundries
- EDA and chip-design software
- Wafer-fabrication and semiconductor-test equipment
- OSAT and advanced packaging
- Silicon wafers, photomasks, process materials, and contamination control
- IC package substrates and semiconductor test interfaces
- Semiconductor lasers, image sensors, and other optoelectronics

`core` means the company is principally a semiconductor or semiconductor-production business. `extended` means the company is diversified but has a large and strategically important semiconductor-enabling business. General electronics assembly, servers, passive components, and industrial suppliers with only incidental semiconductor exposure are excluded.

`included` rows cleared the $15B screen in the snapshot. `watchlist` rows sit just below it and are retained so daily price or FX movements can be updated without rediscovering the company.

## Files

- `data/semiconductor_universe.csv`: company master, preferred ticker, fiscal year, and current market-cap screen
- `data/alternate_listings.csv`: local listings, ADRs, ADSs, and useful ticker aliases
- `data/datapoint_definitions.csv`: definitions for valuation datapoints
- `data/datapoint_values.csv`: dated company datapoint values
- `data/fiscal_forecasts.csv`: fiscal-year consensus totals, diluted shares, and source links
- `data/valuation_inputs.csv`: dated local prices and the few required FX conversions
- `data/calendarized_metrics.csv`: normalized CY2027 and CY2028 output with quality flags
- `data/quality_checks.csv`: source EPS and P/E reconciliation detail
- `data/sec_historical_checks.csv`: selected FCF reconciliations to official SEC filings
- `data/relative_valuation.sqlite`: generated query database
- `database/schema.sql`: normalized SQLite schema
- `scripts/build_database.py`: validates the CSV seeds and rebuilds SQLite atomically
- `scripts/query_database.py`: looks up a company by name or any stored ticker
- `scripts/set_datapoint.py`: adds or replaces a datapoint and rebuilds SQLite
- `scripts/calendarize_forecasts.mjs`: day-weights fiscal forecasts into calendar years
- `docs/methodology.md`: formulas, source process, coverage, and validation results
- `.github/workflows/rebuild-database.yml`: regenerates SQLite after CSV or schema updates

The CSV files are the source of truth. The SQLite file is generated from them and should not be edited directly.
When source files are edited on GitHub, the included workflow validates them and commits the regenerated database automatically.

## Build and query

Node.js and Python 3 are required; both scripts use only standard libraries.

```bash
node scripts/calendarize_forecasts.mjs
python scripts/build_database.py
python scripts/query_database.py NVDA
python scripts/query_database.py NVDA --datapoint cy2027_pe
python scripts/query_database.py 2330.TW --datapoint market_cap_usd_bn
python scripts/query_database.py "Sony Group" --json
```

Queries accept a company id, exact or partial English company name, raw ticker, or exchange-qualified lookup symbol.
`Ticker` prefers a U.S.-listed share, ADR, ADS, or useful U.S. OTC symbol when one is available; otherwise it uses the primary local listing. `Fiscal Year` distinguishes calendar-year reporters from companies with non-standard year ends or 52/53-week rules.

Forward keys use forms such as `cy2027_eps`, `cy2027_fcf_per_share`, `cy2027_pe`, `cy2027_ev_to_fcf`, and `cy2027_net_leverage` (and the same set for 2028). Per-share figures are in the issuer's reporting currency per underlying ordinary share; ratios are unitless. See `docs/methodology.md` before comparing ADR prices directly to per-share output.

## Add a datapoint

New datapoints do not require a schema change. The first write creates the definition; later writes reuse it.

```bash
python scripts/set_datapoint.py NVDA forward_pe 31.4 \
  --as-of 2026-09-02 \
  --type numeric \
  --label "Forward P/E" \
  --unit x

python scripts/query_database.py NVDA --datapoint forward_pe
```

Text and date values are also supported with `--type text` and `--type date`.

## Update the universe

1. Edit `data/semiconductor_universe.csv` or `data/alternate_listings.csv`.
2. Keep `market_cap_as_of` in ISO `YYYY-MM-DD` format.
3. Use `Standard (Dec 31)` or `Non-standard (...)` in `Fiscal Year`.
4. Ensure `Ticker` matches a primary or alternate listing stored for that company.
5. Set `universe_status` to `included` only when `market_cap_usd_bn` is above `15.0`.
6. Run `node scripts/calendarize_forecasts.mjs`.
7. Run `python scripts/build_database.py`.
8. Commit the CSV changes and regenerated SQLite file.

The build fails on duplicate companies, duplicate ticker aliases, invalid dates, unknown foreign keys, malformed datapoints, or an included company at or below the threshold.
