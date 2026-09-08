# Calendar-year valuation methodology

## Scope and source date

The dataset covers CY2027 and CY2028 for the 104-company semiconductor universe. Its current source dates are stored on every raw forecast, valuation, FX, and market-cap row and are displayed automatically in the dashboard and Excel exports. A GitHub Actions workflow refreshes the complete snapshot every Sunday at midnight in `America/New_York`. MarketScreener is the primary fiscal-year consensus feed. Where it has a genuine gap, `data/supplemental_fiscal_forecasts.csv` retains sourced values from public pages that identify FactSet as their data provider, local analyst-consensus portals, issuer filings, and selected forecast tables in publicly hosted broker research PDFs. Historical values and fiscal calendars were checked against company filings, including SEC 10-K filings for U.S. issuers. The three exact FCF checks in `data/sec_historical_checks.csv` reconcile without a difference.

SEC filings do not contain 2027-2029 consensus estimates, so filings are historical and calendar anchors rather than the source of forward estimates. Local share prices are dated in `data/valuation_inputs.csv`.

USD per-share display values use the same weekly snapshot as the valuation inputs. USD-reporting source values are retained exactly. Non-USD values use dated rates stored in `data/fx_rates.csv`: Frankfurter reference rates for supported currencies and a daily TWD reference rate from ExchangeRate-API. MarketScreener's exact USD/local market-cap displays independently cross-check every rate and provide a fallback when a reference endpoint is temporarily unavailable. An issuer-published USD value entered in `data/usd_per_share_overrides.csv` takes priority over FX conversion.

## Process summary

Forward fiscal estimates primarily come from MarketScreener analyst pages, with a source URL retained on every raw row, including NVIDIA and TSMC. SEC filings provide historical and accounting-basis checks because they do not contain future consensus estimates. The researched gap-fill layer uses estimates displayed on public Finanzen pages that identify FactSet as their provider, analyst estimates displayed by 10jqka, and selected forecast tables from publicly hosted broker research PDFs. No direct FactSet terminal or paid feed was accessed, and no private broker portal or proprietary broker database was used. Each supplemental row retains its source URL, retrieval date, method note, and any field deliberately overriding the primary source.

These supplemental sources apply only to specific cells where the primary feed has a genuine gap; they are not the source for most of the matrix. The September 8 gap-fill pass added 30 supplemental fiscal-year rows alongside 511 primary forecast rows, and only the missing fields identified on each supplemental row are merged. MarketScreener remains the primary source for the broad dataset. Public pages attributing estimates to FactSet, 10jqka, publicly hosted broker research PDFs, issuer filings, and official share-count disclosures are used selectively to recover otherwise unavailable EPS, cash-flow, EBITDA, net-debt, or share inputs. ECB and other dated reference rates are conversion inputs rather than forecast sources.

When even those targeted sources do not publish a defensible forward component, the affected output remains `Insufficient Data`. For example, the reviewed sources still omit Cambricon's 2028 FCF and Winbond's 2028 net debt. Ratios are also intentionally left blank when their denominator is negative and the result would not be economically meaningful. Current balance-sheet figures are not substituted for missing forward net debt, and unrelated per-share measures are not used as proxies for FCF/share.

The code determines actual fiscal year-end dates and day-weights adjacent fiscal years. Earnings, FCF, EBITDA, debt, and shares are calendarized as totals; EPS and FCF/share are calculated only afterward. Currency conversion is applied after local per-share values are calculated.

Supplements are field-level and fill-only by default. A populated primary value remains authoritative unless the supplemental row explicitly lists that field in `override_fields`, which is reserved for cases such as an official post-IPO share count. When a full model publishes cash flow from operations and capital expenditure but not FCF, FCF is reconstructed as CFO minus capital expenditure. No value is inferred from revenue growth, historical margins, peer ratios, or an unsupported interpolation.

## Calendarization

For a target calendar year `Y`, the code calculates the actual fiscal year-end date from each company's rule. The fiscal-year weight is:

```text
w = days from Jan 1 through the FY(Y) end date / days in calendar year Y
CY(Y) = w * FY(Y) + (1 - w) * FY(Y+1)
```

The same weighting is applied separately to reconstructed consensus earnings, FCF, EBITDA, diluted shares, and year-end net debt. Fixed and 52/53-week rules are handled in code, including last-weekday and closest-weekday calendars.

Consensus earnings are reconstructed as published fiscal EPS multiplied by fiscal diluted shares. That total is calendarized, and CY EPS is calculated only afterward. This preserves the adjusted consensus basis while obeying the total-first rule. CY FCF/share is likewise calendarized FCF divided by calendarized diluted shares.

## Metric definitions

- `CY EPS = CY consensus earnings / CY diluted shares`
- `CY FCF/share = CY FCF / CY diluted shares`
- `CY EPS (USD) = official USD CY EPS when available; otherwise CY EPS * USD per reporting-currency unit`
- `CY FCF/share (USD) = official USD CY FCF/share when available; otherwise CY FCF/share * USD per reporting-currency unit`
- `CY P/E = valuation-date price in reporting currency / CY EPS`
- `CY EV/FCF = (valuation-date price * CY diluted shares + CY-end net debt) / CY FCF`
- `CY Net leverage = CY-end net debt / CY EBITDA`

Negative P/E and EV/FCF values are left blank as not meaningful. Negative net leverage means net cash. Both local-currency and USD per-share values are per underlying ordinary share, not per ADR. FX normalization aligns currencies but does not normalize differing share counts or ADR ratios; P/E, EV/FCF, and growth rates remain the better cross-company comparisons.

If FY(Y+1) is missing and the uncovered part of the calendar year is no more than 34%, the script holds FY(Y) flat for that tail and labels the result `flat-tail`. It never extrapolates a larger missing period. Missing components remain blank and are labeled `partial`.

## Current audit coverage

- All 208 CY2027/CY2028 rows have EPS in local currency and USD.
- 203 of 208 rows have FCF/share in local currency and USD.
- Across the seven stored display fields, 1,408 of 1,456 cells are populated (96.70%).
- CY2027 has 497 of 520 core metric cells populated; CY2028 has 500 of 520.
- 11 calendar-year rows use the limited flat-tail assumption, all in CY2028.
- The September 8 gap audit recovered 119 of the 167 cells that had previously displayed `Insufficient Data`.
- Remaining blanks are either economically undefined valuation ratios with negative earnings or FCF, or fields for which no defensible public forecast was found. Partial rows retain every metric that can be calculated; they are not filled with invented values.

The detailed recovery and residual-gap review is in `docs/gap-fill-audit-2026-09-08.md`.

## Accuracy checks

For calendar-year reporters, fiscal and calendar years are identical. Across 65 available CY2027/CY2028 P/E checks against the published web ratios, the median absolute difference is 0.11%, the 90th percentile is 2.61%, 59 of 65 are within 3%, 63 of 65 are within 5%, and the maximum is 8.43%. The residual differences reflect intraday/delayed quote timing and rounding. The `computed_pe` field in `data/quality_checks.csv` uses the same consensus-EPS basis as the final output. Every result above 3% was manually rechecked; the decisions are recorded in `docs/pe-recheck-2026-09-03.md`.

Across 481 available fiscal observations, reported net income divided by diluted shares differs from published consensus EPS by a median 1.05% and a 90th percentile of 5.58%. That is primarily the difference between GAAP-style net income and adjusted consensus EPS. The output therefore uses reconstructed consensus earnings; `data/quality_checks.csv` preserves this basis check.

For non-calendar reporters, the arithmetic is deterministic and can be traced through the stored weights. For example, NVIDIA CY2027 EPS is 8.4932% of FY2027 EPS plus 91.5068% of FY2028 EPS. Lam Research CY2027 is approximately half FY2027 and half FY2028. No free public source provided a consistent independent CY2027/CY2028 panel for the full global universe, so the strongest external check is the direct calendar-year subset plus SEC historical reconciliation.

These statistics measure calculation and source consistency, not the chance that consensus forecasts will be realized. Forecast outcome uncertainty remains high, especially for memory companies, loss-making issuers, and recent IPOs.

## Updating

The scheduled workflow runs `python scripts/update_market_data.py` first. It requires all 104 quote pages to validate, retries transient failures, accepts explicitly blank consensus cells, and writes no files if a required source fails. Market caps that are not exposed directly are rolled forward using current price and FX; when no prior quote exists, the latest issuer share count is used. The workflow then performs the same two deterministic build steps used for manual updates.

1. Run `python scripts/update_market_data.py`.
2. Add issuer-published USD per-share values to `data/usd_per_share_overrides.csv` only when they use the underlying ordinary-share basis.
3. Add defensible, sourced primary-feed gaps to `data/supplemental_fiscal_forecasts.csv`.
4. Run `node scripts/calendarize_forecasts.mjs`.
5. Run `python scripts/build_database.py`.

The first command regenerates the wide columns in `data/semiconductor_universe.csv` and the normalized `data/calendarized_metrics.csv`. The second rebuilds SQLite.
