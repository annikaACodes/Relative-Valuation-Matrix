from __future__ import annotations

import sys
import unittest
from decimal import Decimal
from http.client import RemoteDisconnected
from pathlib import Path
from unittest.mock import MagicMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import update_market_data as updater  # noqa: E402


def annual_table(period: str, years: list[int], rows: list[tuple[str, str, list[str]]]) -> str:
    header = "".join(f"<th>{year}</th>" for year in years)
    body = []
    for label, title, values in rows:
        title_attr = f' title="{title}"' if title else ""
        cells = "".join(f"<td>{value}</td>" for value in values)
        body.append(f"<tr><td><sup{title_attr}></sup>{label}</td>{cells}</tr>")
    return (
        f"<table><thead><tr><th>Fiscal Period: {period}</th>{header}</tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table>"
    )


class MarketDataParserTests(unittest.TestCase):
    def test_quote_parser_reads_exact_usd_market_cap_and_price(self) -> None:
        page = """
        <script type="application/ld+json">
          {"offers":{"price":"123.45","priceCurrency":"EUR"}}
        </script>
        <table><tr><td>Market Cap</td><th>
          <span class="efd_USD"><span title="25,500,000,000">25.5B</span></span>
          <span class="efd_EUR"><span title="22,000,000,000">22B</span></span>
        </th></tr></table>
        """
        result = updater.parse_quote_page(page, "example")
        self.assertEqual(result.price, "123.45")
        self.assertEqual(result.price_currency, "EUR")
        self.assertEqual(result.market_cap_usd_bn, "25.50")
        self.assertEqual(result.market_caps["EUR"], Decimal("22000000000"))

    def test_forecast_parser_handles_plural_and_omitted_unit_labels(self) -> None:
        years = [2026, 2027, 2028]
        page = "".join(
            [
                annual_table(
                    "December",
                    years,
                    [
                        ("EBITDA", "", ["900", "1,100", "1,300"]),
                        ("Net income", "KRW in Billions", ["400", "500", "600"]),
                    ],
                ),
                annual_table("December", years, [("Net Debt", "", ["100", "90", "80"])]),
                annual_table(
                    "December",
                    years,
                    [("Free Cash Flow (FCF)", "KRW in Millions", ["300", "350", "400"])],
                ),
                annual_table(
                    "December",
                    years,
                    [
                        ("EPS", "KRW", ["5", "6", "7"]),
                        ("Nbr of stocks (in thousands)", "", ["100", "100", "100"]),
                    ],
                ),
            ]
        )
        result = updater.parse_forecast_page(
            page,
            "example",
            "https://example.com/finances/",
            "2026-09-13",
            [],
            "KRW",
        )
        row_2027 = next(row for row in result.rows if row["fiscal_year"] == "2027")
        self.assertEqual(result.reporting_currency, "KRW")
        self.assertEqual(row_2027["income_scale"], "Billion")
        self.assertEqual(row_2027["net_debt_scale"], "Billion")
        self.assertEqual(row_2027["fcf_scale"], "Million")
        self.assertEqual(row_2027["source_eps"], "6")

    def test_sparse_forecast_adds_blank_target_year(self) -> None:
        years = [2026, 2027]
        page = "".join(
            [
                annual_table(
                    "December",
                    years,
                    [
                        ("EBITDA", "CNY in Million", ["90", "100"]),
                        ("Net income", "CNY in Million", ["40", "50"]),
                    ],
                ),
                annual_table("December", years, [("Net Debt", "CNY in Million", ["10", "5"])]),
                annual_table(
                    "December", years, [("Free Cash Flow (FCF)", "CNY in Million", ["30", "35"])]
                ),
                annual_table(
                    "December",
                    years,
                    [
                        ("EPS", "CNY", ["1", "1.2"]),
                        ("Nbr of stocks (in thousands)", "", ["100", "100"]),
                    ],
                ),
            ]
        )
        result = updater.parse_forecast_page(
            page, "example", "https://example.com/", "2026-09-13", [], "CNY"
        )
        row_2028 = next(row for row in result.rows if row["fiscal_year"] == "2028")
        self.assertEqual(row_2028["source_eps"], "")
        self.assertEqual(row_2028["fcf"], "")

    def test_historical_share_fallback_prefers_common_shares(self) -> None:
        page = """
        <table><tr><th>Fiscal Period: December</th><th>2024 (CNY)</th><th>2025 (CNY)</th></tr>
        <tr><td>ECS Total Common Shares Outstanding</td><td>1.5B</td><td>1.61B</td></tr>
        <tr><td>Diluted Weighted Average Shares Outstanding</td><td>1.4B</td><td>1.55B</td></tr>
        </table>
        """
        self.assertEqual(updater.parse_latest_shares_outstanding(page), Decimal("1610000000"))

    def test_market_cap_guard_rejects_fourfold_jump(self) -> None:
        with self.assertRaises(updater.UpdateError):
            updater.validate_market_cap_change("example", "20", "100")

    def test_micron_allows_53_week_fiscal_period_month_shift(self) -> None:
        updater.validate_fiscal_period_transition("micron", "September", {"August"})

    def test_other_fiscal_period_month_shift_is_rejected(self) -> None:
        with self.assertRaises(updater.UpdateError):
            updater.validate_fiscal_period_transition("example", "September", {"August"})

    def test_request_retries_remote_disconnect(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b"x" * 101
        response.headers.get_content_charset.return_value = "utf-8"
        with (
            patch.object(
                updater,
                "urlopen",
                side_effect=[RemoteDisconnected("closed"), response],
            ),
            patch.object(updater.time, "sleep") as sleep,
        ):
            result = updater.request_text("https://example.com", attempts=2, timeout=1)
        self.assertEqual(result, "x" * 101)
        sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
