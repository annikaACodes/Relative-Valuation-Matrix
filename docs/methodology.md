# Calendar-year valuation methodology

## Scope and source date

The forward dataset was collected on 2026-09-03. It covers CY2027 and CY2028 for the 104-company semiconductor universe. Forward fiscal-year consensus inputs come from the MarketScreener analyst forecast page recorded on every raw row. Historical values and fiscal calendars were checked against company filings, including SEC 10-K filings for U.S. issuers. The three exact FCF checks in `data/sec_historical_checks.csv` reconcile without a difference.

SEC filings do not contain 2027-2029 consensus estimates, so filings are historical and calendar anchors rather than the source of forward estimates. Local share prices are dated in `data/valuation_inputs.csv`. The EUR/USD and HKD/USD conversions are the 2026-09-03 Frankfurter rates; all other quote and reporting currencies already match.

## Process summary

Forward fiscal estimates primarily come from MarketScreener analyst pages, with a source URL retained on every raw row, including NVIDIA and TSMC. SEC filings provide historical and accounting-basis checks because they do not contain future consensus estimates.

The code determines actual fiscal year-end dates and day-weights adjacent fiscal years. Earnings, FCF, EBITDA, debt, and shares are calendarized as totals; EPS and FCF/share are calculated only afterward. Required EUR/USD and HKD/USD conversions use Frankfurter.

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
- `CY P/E = valuation-date price in reporting currency / CY EPS`
- `CY EV/FCF = (valuation-date price * CY diluted shares + CY-end net debt) / CY FCF`
- `CY Net leverage = CY-end net debt / CY EBITDA`

Negative P/E and EV/FCF values are left blank as not meaningful. Negative net leverage means net cash. Per-share values are in the issuer's reporting currency per underlying ordinary share, not per ADR. Unitless ratios remain comparable across listings.

If FY(Y+1) is missing and the uncovered part of the calendar year is no more than 34%, the script holds FY(Y) flat for that tail and labels the result `flat-tail`. It never extrapolates a larger missing period. Missing components remain blank and are labeled `partial`.

## Coverage

- CY2027: 91 of 104 companies have all five metrics.
- CY2028: 86 of 104 companies have all five metrics.
- 11 calendar-year rows use the limited flat-tail assumption, all in CY2028.
- Five recent listings have no usable forward consensus statement: Cerebras Systems, SJ Semiconductor, Moore Threads Technology, DapuStor, and Xi'an Eswin Material Technology.
- Other partial rows retain every metric that can be calculated; they are not filled with invented values.

## Accuracy checks

For calendar-year reporters, fiscal and calendar years are identical. Across 65 available CY2027/CY2028 P/E checks against the published web ratios, the median absolute difference is 0.11%, the 90th percentile is 2.61%, 59 of 65 are within 3%, 63 of 65 are within 5%, and the maximum is 8.43%. The residual differences reflect intraday/delayed quote timing and rounding. The `computed_pe` field in `data/quality_checks.csv` uses the same consensus-EPS basis as the final output. Every result above 3% was manually rechecked; the decisions are recorded in `docs/pe-recheck-2026-09-03.md`.

Across 481 available fiscal observations, reported net income divided by diluted shares differs from published consensus EPS by a median 1.05% and a 90th percentile of 5.58%. That is primarily the difference between GAAP-style net income and adjusted consensus EPS. The output therefore uses reconstructed consensus earnings; `data/quality_checks.csv` preserves this basis check.

For non-calendar reporters, the arithmetic is deterministic and can be traced through the stored weights. For example, NVIDIA CY2027 EPS is 8.4932% of FY2027 EPS plus 91.5068% of FY2028 EPS. Lam Research CY2027 is approximately half FY2027 and half FY2028. No free public source provided a consistent independent CY2027/CY2028 panel for the full global universe, so the strongest external check is the direct calendar-year subset plus SEC historical reconciliation.

These statistics measure calculation and source consistency, not the chance that consensus forecasts will be realized. Forecast outcome uncertainty remains high, especially for memory companies, loss-making issuers, and recent IPOs.

## Updating

1. Replace or add fiscal estimates in `data/fiscal_forecasts.csv`.
2. Refresh prices and any required FX in `data/valuation_inputs.csv`.
3. Run `node scripts/calendarize_forecasts.mjs`.
4. Run `python scripts/build_database.py`.

The first command regenerates the wide columns in `data/semiconductor_universe.csv` and the normalized `data/calendarized_metrics.csv`. The second rebuilds SQLite.
