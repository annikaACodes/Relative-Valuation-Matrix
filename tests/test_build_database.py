from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import build_database as builder  # noqa: E402


def forecast_row(**values: str) -> dict[str, str]:
    row = {
        "company_id": "example",
        "fiscal_year": "2028",
        "source_url": "https://example.com/primary",
        "source_retrieved_at": "2026-09-01",
        **{column: "" for column in builder.FORECAST_VALUE_COLUMNS},
    }
    row.update(values)
    return row


def supplemental_row(**values: str) -> dict[str, str]:
    row = forecast_row(
        source_url="https://example.com/supplement",
        source_retrieved_at="2026-09-08",
    )
    row.update({"override_fields": "", "source_note": "Analyst model"})
    row.update(values)
    return row


class FiscalForecastMergeTests(unittest.TestCase):
    def test_supplement_only_row_has_complete_database_shape(self) -> None:
        result = builder.merge_fiscal_forecasts(
            [], [supplemental_row(source_eps="2.50", diluted_shares_thousands="1000")]
        )

        self.assertEqual(result[0]["source_eps"], "2.50")
        self.assertEqual(result[0]["net_debt"], "")
        self.assertEqual(result[0]["source_url"], "https://example.com/supplement")

    def test_supplement_fills_blanks_without_replacing_primary_values(self) -> None:
        primary = forecast_row(source_eps="2.00", fcf="")
        supplement = supplemental_row(source_eps="2.50", fcf="300")

        result = builder.merge_fiscal_forecasts([primary], [supplement])

        self.assertEqual(result[0]["source_eps"], "2.00")
        self.assertEqual(result[0]["fcf"], "300")
        self.assertEqual(result[0]["source_retrieved_at"], "2026-09-08")

    def test_explicit_override_replaces_primary_value(self) -> None:
        primary = forecast_row(diluted_shares_thousands="900")
        supplement = supplemental_row(
            diluted_shares_thousands="1000",
            share_source_method="post-IPO ordinary shares",
            override_fields="diluted_shares_thousands",
        )

        result = builder.merge_fiscal_forecasts([primary], [supplement])

        self.assertEqual(result[0]["diluted_shares_thousands"], "1000")
        self.assertEqual(result[0]["share_source_method"], "post-IPO ordinary shares")


if __name__ == "__main__":
    unittest.main()
