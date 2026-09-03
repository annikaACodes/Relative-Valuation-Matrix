# P/E discrepancy recheck: 2026-09-03

## Scope

The original direct-calendar-year audit had eight CY2027 P/E comparisons more than 3% away from MarketScreener's displayed ratio. Each was rechecked for fiscal period, EPS, share units, currency, FX, and quote timing. Forecast EPS was confirmed for all eight.

MarketScreener's finance-page P/E can retain an earlier reference price while the quote page has moved intraday. The database intentionally calculates valuation ratios from the dated price stored in `data/valuation_inputs.csv`, so a stale published comparison is not substituted for an observed quote.

## Values changed

| Company | Price change | CY2027 P/E change | Result |
| --- | ---: | ---: | --- |
| Renesas Electronics | JPY 3,314 to JPY 3,291 | 17.72x to 17.60x | Replaced the intraday value with the final September 3 close. Difference versus the displayed 17.2x fell from 3.03% to 2.35%. |
| Hua Hong Semiconductor | HKD 116.90 to HKD 119.50 | 95.11x to 97.23x | Replaced the intraday value with the final September 3 close. Difference versus the displayed 98.5x fell from 3.44% to 1.29%. |

## Values retained

| Company | Stored price and EPS | Calculated vs. displayed P/E | Decision |
| --- | --- | --- | --- |
| ACM Research Shanghai | CNY 305.40; EPS 6.301 | 48.47x vs. 44.7x | Keep. EPS and units are correct. The displayed ratio implies CNY 281.65, close to the prior quote snapshot rather than the stored September 3 price. |
| Nanya Technology | TWD 477.50; EPS 96.94 | 4.93x vs. 5.34x | Keep. Independent September 3 quote checks confirm TWD 477.50 and a TWD 518.00 previous close; the displayed ratio uses approximately the previous close. |
| BIWIN Storage Technology | CNY 227.82; EPS 15.94 | 14.29x vs. 15.0x | Keep. The contemporaneous quote-page P/E is 14.3x; the finance-page value uses an earlier reference price. |
| Resonac Holdings | JPY 15,450; EPS 807.6 | 19.13x vs. 20.0x | Keep. The September 3 quote is JPY 15,450; the finance table retained a JPY 16,175 reference price from August 28. |
| NXP Semiconductors | USD 229.40; EPS 15.63 | 14.68x vs. 14.2x | Keep. The stored intraday price was inside the September 3 trading range; the displayed finance-page ratio was based on the earlier USD 222.40 close. |
| ASM International | EUR 771.00; EPS 31.15 | 24.75x vs. 25.6x | Keep. EUR 771.00 was the live September 3 quote; the displayed ratio used the EUR 797.60 prior close. |

## Sources

- Forecast EPS and displayed ratios: the MarketScreener finance URL stored on each row of `data/fiscal_forecasts.csv`.
- Dated valuation prices: the quote URL stored on each row of `data/valuation_inputs.csv`.
- Nanya September 3 cross-check: [Investing.com](https://www.investing.com/equities/nanya-tech).
- Hua Hong September 3 close: [MarketScreener quotes](https://www.marketscreener.com/quote/stock/HUA-HONG-GRACE-SEMICONDUC-18231307/quotes/).
- Resonac September 3 close: [MarketScreener quote](https://www.marketscreener.com/quote/stock/RESONAC-HOLDINGS-CORPORAT-6491222/).
- ASM live quote and previous close: [MarketScreener quote](https://www.marketscreener.com/quote/stock/ASM-INTERNATIONAL-N-V-6312/).
