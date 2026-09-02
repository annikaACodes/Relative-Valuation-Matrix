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


def load_and_validate() -> tuple[list[dict[str, str]], ...]:
    universe_path = DATA_DIR / "semiconductor_universe.csv"
    alternates_path = DATA_DIR / "alternate_listings.csv"
    definitions_path = DATA_DIR / "datapoint_definitions.csv"
    values_path = DATA_DIR / "datapoint_values.csv"

    universe = read_rows(universe_path)
    alternates = read_rows(alternates_path)
    definitions = read_rows(definitions_path)
    values = read_rows(values_path)

    require_columns(
        universe_path,
        universe,
        {
            "company_id", "company_name", "country", "segment", "inclusion_tier",
            "universe_status", "market_cap_usd_bn", "market_cap_as_of",
            "primary_ticker", "primary_exchange", "primary_currency",
            "primary_lookup_symbol", "notes",
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

    company_ids: set[str] = set()
    company_names: set[str] = set()
    listing_keys: set[tuple[str, str]] = set()
    lookup_symbols: set[str] = set()

    for row in universe:
        company_id = row["company_id"]
        if not COMPANY_ID_RE.fullmatch(company_id):
            raise ValueError(f"Invalid company_id: {company_id}")
        if company_id in company_ids:
            raise ValueError(f"Duplicate company_id: {company_id}")
        company_ids.add(company_id)

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

        listing_key = (row["primary_ticker"].casefold(), row["primary_exchange"].casefold())
        lookup_key = row["primary_lookup_symbol"].casefold()
        if listing_key in listing_keys or lookup_key in lookup_symbols:
            raise ValueError(f"Duplicate primary listing for {company_id}")
        listing_keys.add(listing_key)
        lookup_symbols.add(lookup_key)

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

    return universe, alternates, definitions, values


def build_database(output_path: Path) -> dict[str, int]:
    universe, alternates, definitions, values = load_and_validate()
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
                ("seed_format_version", "2"),
            ],
        )

        for row in universe:
            connection.execute(
                "INSERT INTO companies VALUES (?, ?, ?, ?, ?, ?, 1)",
                (
                    row["company_id"], row["company_name"], row["country"], row["segment"],
                    row["inclusion_tier"], row["notes"],
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
