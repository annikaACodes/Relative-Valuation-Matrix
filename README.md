# Relative Valuation Matrix

Starter repository for a semiconductor relative-valuation database.

## Current Data

- `data/semiconductor_universe.csv` contains the initial stock universe.
- Universe threshold: publicly traded companies with market cap above about USD 15 billion.
- As-of date: September 2, 2026.
- Scope is intentionally broad: chip designers, foundries, memory, EDA/IP, IDMs, semiconductor equipment, metrology/test, OSAT/packaging, semiconductor materials, and advanced IC substrate suppliers.
- Exclusions are intentional for companies whose semiconductor exposure is too incidental relative to the rest of the business.

## Ticker Rules

- `primary_ticker` is the ticker to try first for lookups.
- Major U.S.-listed ADRs/ADSs are used as the primary ticker where practical, for example `TSM`, `ASML`, `ASX`, `UMC`, and `STM`.
- Local tickers are retained in `local_ticker`.
- OTC ADRs are captured in `us_adr_ticker` when useful, but local tickers remain primary for many non-U.S. listings.

## Source Keys

- `companiesmarketcap_semis`: CompaniesMarketCap semiconductor market-cap ranking.
- `companiesmarketcap_*`: CompaniesMarketCap company-specific market-cap pages.
- `macrotrends_*`: Macrotrends market-cap pages.
- `robinhood_teradyne`: Robinhood market snapshot for Teradyne.
- `pitchbook_*`: PitchBook company profile market-cap snapshots.

This is a first-pass seed. Borderline and semiconductor-adjacent names can be tightened or expanded as the datapoint set takes shape.
