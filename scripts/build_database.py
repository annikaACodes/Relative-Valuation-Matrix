#!/usr/bin/env python3
"""Build the SQLite database from the repository's reviewable CSV seeds."""

from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
SCHEMA_PATH = ROOT / "database" / "schema.sql"
DEFAULT_DB_PATH = DATA_DIR / "relative_valuation.sqlite"
THRESHOLD_USD_BN = 15.0
COMPANY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
NONSTANDARD_FISCAL_YEAR_RE = re.compile(r"^Non-standard \((.+)\)$")


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"Missing CSV header: {path}")
        return [
            {key: (value or "").strip() for key, value in row.items()}
            for row in reader
            if any((value or "").strip() for value in row.values())
        ]


def require_columns(path: Path, rows: list[dict[str, str]], columns: set[str]) -> None:
    if rows:
        present = set(rows[0])
    else:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            present = set(next(csv.reader(handle), []))
    missing = columns - present
    if missing:
        raise ValueError(f"{path} is missing columns: {', '.join(sorted(missing))}")


def valid_date(value: str, field: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError(f"Invalid ISO date for {field}: {value}") from exc


def parse_fiscal_year(value: str, company_id: str) -> tuple[int, str]:
    if value == "Standard (Dec 31)":
        return 1, "Dec 31"
    match = NONSTANDARD_FISCAL_YEAR_RE.fullmatch(value)
    if not match:
        raise ValueError(f"Invalid Fiscal Year for {company_id}: {value}")
    return 0, match.group(1)


def load_and_validate() -> tuple[list[dict[str, str]], ...]:
    universe_path = DATA_DIR / "semiconductor_universe.csv"
    alternates_path = DATA_DIR / "alternate_listings.csv"
    definitions_path = DATA_DIR / "datapoint_definitions.csv"
    values_path = DATA_DIR / "datapoint_values.csv"
    fiscal_forecasts_path = DATA_DIR / "fiscal_forecasts.csv"
    valuation_inputs_path = DATA_DIR / "valuation_inputs.csv"
    calendarized_metrics_path = DATA_DIR / "calendarized_metrics.csv"

    universe = read_rows(universe_path)
    alternates = read_rows(alternates_path)
    definitions = read_rows(definitions_path)
    values = read_rows(values_path)
    fiscal_forecasts = read_rows(fiscal_forecasts_path)
    valuation_inputs = read_rows(valuation_inputs_path)
    calendarized_metrics = read_rows(calendarized_metrics_path)

    require_columns(
        universe_path,
        universe,
        {
            "company_id", "company_name", "country", "segment", "inclusion_tier",
            "universe_status", "market_cap_usd_bn", "market_cap_as_of",
            "primary_ticker", "primary_exchange", "primary_currency",
            "primary_lookup_symbol", "Ticker", "Fiscal Year", "notes",
        },
    )
    require_columns(
        alternates_path,
        alternates,
        {"company_id", "ticker", "exchange", "currency", "security_type", "lookup_symbol"},
    )
    require_columns(
        definitions_path,
        definitions,
        {"datapoint_key", "label", "value_type", "unit", "description"},
    )
    require_columns(
        values_path,
        values,
        {"company_id", "datapoint_key", "as_of_date", "numeric_value", "text_value", "source_note"},
    )
    require_columns(
        fiscal_forecasts_path,
        fiscal_forecasts,
        {
            "company_id", "fiscal_year", "fiscal_period", "reporting_currency",
            "net_income", "income_scale", "ebitda", "fcf", "fcf_scale",
            "net_debt", "net_debt_scale", "diluted_shares_thousands", "source_eps",
            "share_source_method", "source_url", "source_retrieved_at",
        },
    )
    require_columns(
        valuation_inputs_path,
        valuation_inputs,
        {
            "company_id", "valuation_date", "price", "price_currency",
            "price_source_url", "forecast_source_url", "input_status",
            "reporting_currency", "price_to_reporting_fx", "fx_source_url",
        },
    )
    require_columns(
        calendarized_metrics_path,
        calendarized_metrics,
        {
            "company_id", "calendar_year", "reporting_currency", "fiscal_year_weight",
            "next_fiscal_year_weight", "eps", "fcf_per_share", "pe", "ev_to_fcf",
            "net_leverage", "calculation_quality", "tail_imputed", "missing_input_count",
            "earnings_basis", "valuation_date", "forecast_source_date",
        },
    )

    company_ids: set[str] = set()
    company_names: set[str] = set()
    listing_keys: set[tuple[str, str]] = set()
    lookup_symbols: set[str] = set()
    company_symbols: dict[str, set[str]] = {}

    for row in universe:
        company_id = row["company_id"]
        if not COMPANY_ID_RE.fullmatch(company_id):
            raise ValueError(f"Invalid company_id: {company_id}")
        if company_id in company_ids:
            raise ValueError(f"Duplicate company_id: {company_id}")
        company_ids.add(company_id)
        company_symbols[company_id] = set()

        name_key = row["company_name"].casefold()
        if not name_key or name_key in company_names:
            raise ValueError(f"Blank or duplicate company_name: {row['company_name']}")
        company_names.add(name_key)

        if row["inclusion_tier"] not in {"core", "extended"}:
            raise ValueError(f"Invalid inclusion_tier for {company_id}")
        if row["universe_status"] not in {"included", "watchlist"}:
            raise ValueError(f"Invalid universe_status for {company_id}")

        market_cap = float(row["market_cap_usd_bn"])
        if market_cap <= 0:
            raise ValueError(f"Non-positive market cap for {company_id}")
        if row["universe_status"] == "included" and market_cap <= THRESHOLD_USD_BN:
            raise ValueError(f"Included company is not above ${THRESHOLD_USD_BN:g}B: {company_id}")
        valid_date(row["market_cap_as_of"], f"market_cap_as_of/{company_id}")
        if not row["Ticker"]:
            raise ValueError(f"Blank Ticker for {company_id}")
        parse_fiscal_year(row["Fiscal Year"], company_id)

        listing_key = (row["primary_ticker"].casefold(), row["primary_exchange"].casefold())
        lookup_key = row["primary_lookup_symbol"].casefold()
        if listing_key in listing_keys or lookup_key in lookup_symbols:
            raise ValueError(f"Duplicate primary listing for {company_id}")
        listing_keys.add(listing_key)
        lookup_symbols.add(lookup_key)
        company_symbols[company_id].update(
            {row["primary_ticker"].casefold(), row["primary_lookup_symbol"].casefold()}
        )

    for row in alternates:
        if row["company_id"] not in company_ids:
            raise ValueError(f"Unknown alternate-listing company_id: {row['company_id']}")
        listing_key = (row["ticker"].casefold(), row["exchange"].casefold())
        lookup_key = row["lookup_symbol"].casefold()
        if listing_key in listing_keys:
            raise ValueError(f"Duplicate ticker/exchange: {row['ticker']} {row['exchange']}")
        if lookup_key in lookup_symbols:
            raise ValueError(f"Duplicate lookup_symbol: {row['lookup_symbol']}")
        listing_keys.add(listing_key)
        lookup_symbols.add(lookup_key)
        company_symbols[row["company_id"]].update(
            {row["ticker"].casefold(), row["lookup_symbol"].casefold()}
        )

    for row in universe:
        if row["Ticker"].casefold() not in company_symbols[row["company_id"]]:
            raise ValueError(
                f"Preferred Ticker is not a stored listing for {row['company_id']}: {row['Ticker']}"
            )

    definition_keys: set[str] = set()
    definition_types: dict[str, str] = {}
    for row in definitions:
        key = row["datapoint_key"]
        if not COMPANY_ID_RE.fullmatch(key.replace("_", "-")):
            raise ValueError(f"Invalid datapoint_key: {key}")
        if key in definition_keys:
            raise ValueError(f"Duplicate datapoint_key: {key}")
        if row["value_type"] not in {"numeric", "text", "date"}:
            raise ValueError(f"Invalid value_type for {key}")
        definition_keys.add(key)
        definition_types[key] = row["value_type"]

    value_keys: set[tuple[str, str, str]] = set()
    for row in values:
        company_id = row["company_id"]
        datapoint_key = row["datapoint_key"]
        if company_id not in company_ids:
            raise ValueError(f"Unknown datapoint company_id: {company_id}")
        if datapoint_key not in definition_keys:
            raise ValueError(f"Unknown datapoint_key: {datapoint_key}")
        as_of = valid_date(row["as_of_date"], f"as_of_date/{company_id}/{datapoint_key}")
        value_key = (company_id, datapoint_key, as_of)
        if value_key in value_keys:
            raise ValueError(f"Duplicate datapoint value: {value_key}")
        value_keys.add(value_key)

        numeric = row["numeric_value"]
        text = row["text_value"]
        if definition_types[datapoint_key] == "numeric":
            if not numeric or text:
                raise ValueError(f"Numeric datapoint has invalid value fields: {value_key}")
            float(numeric)
        else:
            if numeric or not text:
                raise ValueError(f"Text/date datapoint has invalid value fields: {value_key}")
            if definition_types[datapoint_key] == "date":
                valid_date(text, f"date_value/{company_id}/{datapoint_key}")

    forecast_keys: set[tuple[str, int]] = set()
    for row in fiscal_forecasts:
        company_id = row["company_id"]
        fiscal_year = int(row["fiscal_year"])
        if company_id not in company_ids:
            raise ValueError(f"Unknown fiscal forecast company_id: {company_id}")
        key = (company_id, fiscal_year)
        if key in forecast_keys:
            raise ValueError(f"Duplicate fiscal forecast: {key}")
        forecast_keys.add(key)
        valid_date(row["source_retrieved_at"], f"source_retrieved_at/{company_id}/{fiscal_year}")

    valuation_company_ids: set[str] = set()
    for row in valuation_inputs:
        company_id = row["company_id"]
        if company_id not in company_ids or company_id in valuation_company_ids:
            raise ValueError(f"Unknown or duplicate valuation input: {company_id}")
        valuation_company_ids.add(company_id)
        valid_date(row["valuation_date"], f"valuation_date/{company_id}")
    if valuation_company_ids != company_ids:
        raise ValueError("valuation_inputs.csv must contain exactly one row per company")

    metric_keys: set[tuple[str, int]] = set()
    for row in calendarized_metrics:
        company_id = row["company_id"]
        calendar_year = int(row["calendar_year"])
        if company_id not in company_ids or calendar_year not in {2027, 2028}:
            raise ValueError(f"Invalid calendarized metric row: {company_id}/{calendar_year}")
        key = (company_id, calendar_year)
        if key in metric_keys:
            raise ValueError(f"Duplicate calendarized metric: {key}")
        metric_keys.add(key)
        if row["calculation_quality"] not in {"direct", "flat-tail", "partial"}:
            raise ValueError(f"Invalid calculation_quality: {key}")
    if len(metric_keys) != len(company_ids) * 2:
        raise ValueError("calendarized_metrics.csv must contain 2027 and 2028 for every company")

    return (
        universe, alternates, definitions, values,
        fiscal_forecasts, valuation_inputs, calendarized_metrics,
    )


def build_database(output_path: Path) -> dict[str, int]:
    (
        universe, alternates, definitions, values,
        fiscal_forecasts, valuation_inputs, calendarized_metrics,
    ) = load_and_validate()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    if temp_path.exists():
        temp_path.unlink()

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    connection = sqlite3.connect(temp_path)
    try:
        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        connection.executemany(
            "INSERT INTO metadata(key, value) VALUES (?, ?)",
            [
                ("database_name", "Relative Valuation Matrix"),
                ("generated_at_utc", generated_at),
                ("market_cap_threshold_usd_bn", str(THRESHOLD_USD_BN)),
                ("seed_format_version", "4"),
            ],
        )

        for row in universe:
            fiscal_year_is_calendar, fiscal_year_end = parse_fiscal_year(
                row["Fiscal Year"], row["company_id"]
            )
            connection.execute(
                """INSERT INTO companies
                   (company_id, company_name, country, segment, inclusion_tier,
                    preferred_ticker, fiscal_year_is_calendar, fiscal_year_end, notes, active)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    row["company_id"], row["company_name"], row["country"], row["segment"],
                    row["inclusion_tier"], row["Ticker"], fiscal_year_is_calendar,
                    fiscal_year_end, row["notes"],
                ),
            )
            connection.execute(
                """INSERT INTO listings
                   (company_id, ticker, exchange, currency, security_type, lookup_symbol, is_primary)
                   VALUES (?, ?, ?, ?, 'primary', ?, 1)""",
                (
                    row["company_id"], row["primary_ticker"], row["primary_exchange"],
                    row["primary_currency"], row["primary_lookup_symbol"],
                ),
            )
            connection.execute(
                "INSERT INTO universe_screenings VALUES (?, ?, ?, ?, ?)",
                (
                    row["company_id"], row["market_cap_as_of"],
                    float(row["market_cap_usd_bn"]), THRESHOLD_USD_BN, row["universe_status"],
                ),
            )

        connection.executemany(
            """INSERT INTO listings
               (company_id, ticker, exchange, currency, security_type, lookup_symbol, is_primary)
               VALUES (:company_id, :ticker, :exchange, :currency, :security_type, :lookup_symbol, 0)""",
            alternates,
        )
        connection.executemany(
            """INSERT INTO datapoint_definitions
               (datapoint_key, label, value_type, unit, description)
               VALUES (:datapoint_key, :label, :value_type, :unit, :description)""",
            definitions,
        )
        connection.executemany(
            """INSERT INTO datapoint_values
               (company_id, datapoint_key, as_of_date, numeric_value, text_value, source_note, updated_at)
               VALUES (:company_id, :datapoint_key, :as_of_date, :numeric_value, :text_value, :source_note, :updated_at)""",
            [
                {
                    **row,
                    "numeric_value": float(row["numeric_value"]) if row["numeric_value"] else None,
                    "text_value": row["text_value"] or None,
                    "updated_at": generated_at,
                }
                for row in values
            ],
        )
        numeric_forecast_columns = {
            "net_income", "ebitda", "fcf", "net_debt",
            "diluted_shares_thousands", "source_eps",
        }
        connection.executemany(
            """INSERT INTO fiscal_forecasts VALUES
               (:company_id, :fiscal_year, :fiscal_period, :reporting_currency,
                :net_income, :income_scale, :ebitda, :fcf, :fcf_scale,
                :net_debt, :net_debt_scale, :diluted_shares_thousands, :source_eps,
                :share_source_method, :source_url, :source_retrieved_at)""",
            [
                {
                    **row,
                    "fiscal_year": int(row["fiscal_year"]),
                    **{
                        column: float(row[column]) if row[column] else None
                        for column in numeric_forecast_columns
                    },
                }
                for row in fiscal_forecasts
            ],
        )
        connection.executemany(
            """INSERT INTO valuation_inputs VALUES
               (:company_id, :valuation_date, :price, :price_currency,
                :price_source_url, :forecast_source_url, :input_status,
                :reporting_currency, :price_to_reporting_fx, :fx_source_url)""",
            [
                {
                    **row,
                    "price": float(row["price"]) if row["price"] else None,
                    "price_to_reporting_fx": (
                        float(row["price_to_reporting_fx"])
                        if row["price_to_reporting_fx"] else None
                    ),
                }
                for row in valuation_inputs
            ],
        )
        numeric_metric_columns = {
            "fiscal_year_weight", "next_fiscal_year_weight", "eps", "fcf_per_share",
            "pe", "ev_to_fcf", "net_leverage",
        }
        connection.executemany(
            """INSERT INTO calendarized_metrics VALUES
               (:company_id, :calendar_year, :reporting_currency,
                :fiscal_year_weight, :next_fiscal_year_weight, :eps, :fcf_per_share,
                :pe, :ev_to_fcf, :net_leverage, :calculation_quality, :tail_imputed,
                :missing_input_count, :earnings_basis, :valuation_date,
                :forecast_source_date)""",
            [
                {
                    **row,
                    "calendar_year": int(row["calendar_year"]),
                    "tail_imputed": int(row["tail_imputed"]),
                    "missing_input_count": int(row["missing_input_count"]),
                    **{
                        column: float(row[column]) if row[column] else None
                        for column in numeric_metric_columns
                    },
                }
                for row in calendarized_metrics
            ],
        )

        bad_primary_count = connection.execute(
            """SELECT COUNT(*) FROM (
                   SELECT company_id FROM listings GROUP BY company_id
                   HAVING SUM(is_primary) <> 1
               )"""
        ).fetchone()[0]
        if bad_primary_count:
            raise ValueError(f"{bad_primary_count} companies do not have exactly one primary listing")

        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"SQLite integrity check failed: {integrity}")
        connection.commit()
    except Exception:
        connection.close()
        temp_path.unlink(missing_ok=True)
        raise
    else:
        connection.close()

    os.replace(temp_path, output_path)
    included = sum(row["universe_status"] == "included" for row in universe)
    return {
        "companies": len(universe),
        "included": included,
        "watchlist": len(universe) - included,
        "listings": len(universe) + len(alternates),
        "datapoint_values": len(values),
        "fiscal_forecasts": len(fiscal_forecasts),
        "calendarized_metrics": len(calendarized_metrics),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_DB_PATH)
    args = parser.parse_args()
    counts = build_database(args.output.resolve())
    print(f"Built {args.output.resolve()}")
    print(
        f"{counts['included']} included, {counts['watchlist']} watchlist, "
        f"{counts['listings']} listings, {counts['datapoint_values']} datapoint values"
    )


if __name__ == "__main__":
    main()
