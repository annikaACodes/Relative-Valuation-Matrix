# Forecast gap-fill audit: September 8, 2026

## Result

The matrix began with 167 blank display cells across CY2027 and CY2028. A company-by-company search recovered 119 of them, leaving 48 blank cells and raising display-field coverage to 96.70%. All 208 rows now have local and USD EPS; 203 have local and USD FCF/share.

The largest improvements were for recent listings and companies whose primary forecast page exposed only part of the analyst model. New values were added for CXMT, Cerebras Systems, SJ Semiconductor, Moore Threads Technology, DapuStor, Changchuan Technology, Longsys Electronics, Centec Communications, ACM Research Shanghai, Skyverse Technology, Lasertec, Xi'an Eswin Material Technology, Biwin Storage Technology, Tongfu Microelectronics, and Techwinsemi Technology. A later fiscal year was also added for Coherent so its non-calendar CY2028 calculation no longer depended on a missing tail.

## Source hierarchy

1. Broader current consensus remained preferred when MarketScreener or a local consensus portal exposed the required field.
2. FactSet estimates displayed by Finanzen filled selected full-year gaps.
3. Full broker models supplied exact statement components when broader consensus did not publish them.
4. Official post-IPO share counts replaced stale pre-offering share counts where necessary.
5. FCF was reconstructed only when the same source model supplied both CFO and capital expenditure.

Every researched input is stored in `data/supplemental_fiscal_forecasts.csv` with a URL, retrieval date, and source note. The database also records those rows in `forecast_supplements`. Supplements fill blank primary fields by default; deliberate replacements require an explicit `override_fields` entry.

## Remaining blanks

Negative P/E and EV/FCF values remain blank because those ratios are not economically meaningful. This applies to loss-making or negative-FCF periods for Intel, Cambricon Technologies, ASE Technology, SMIC, Cerebras Systems, Ibiden, Yuanjie Semiconductor, Hua Hong Semiconductor, Tower Semiconductor, Skyverse Technology, Techwinsemi Technology, and Xi'an Eswin Material Technology.

The true residual forecast gaps are concentrated in projected FCF or balance-sheet fields for CXMT, Cambricon, SJ Semiconductor, Moore Threads, DapuStor, Winbond Electronics, Skyverse Technology, and Xi'an Eswin Material Technology. Public pages were checked more broadly for these companies, but no defensible matching-year capex, EBITDA, or net-debt forecast was available. CFO/share alone was not treated as FCF/share, and a missing net-debt forecast was not replaced with a current balance-sheet value.

## Important limitations

Some recovered values for recent IPOs come from a single detailed broker model because a multi-analyst statement forecast was unavailable. Broad consensus EPS was retained where possible, while model-derived FCF, EBITDA, and net debt remain traceable to their report. These are more useful than blank cells, but they should not be mistaken for a uniform analyst sample.

This audit checks source consistency and calculation integrity, not whether the forecasts will be achieved. Estimates for memory companies, recent IPOs, and currently loss-making issuers carry especially high outcome uncertainty.
