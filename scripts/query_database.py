#!/usr/bin/env python3
"""Look up a company by name or ticker and return its latest datapoints."""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT / "data" / "relative_valuation.sqlite"


def resolve_company(connection: sqlite3.Connection, identifier: str) -> list[sqlite3.Row]:
    exact = connection.execute(
        """SELECT DISTINCT c.company_id, c.company_name
           FROM companies AS c
           LEFT JOIN listings AS l ON l.company_id = c.company_id
           WHERE c.company_id = ? COLLATE NOCASE
              OR c.company_name = ? COLLATE NOCASE
              OR l.ticker = ? COLLATE NOCASE
              OR l.lookup_symbol = ? COLLATE NOCASE
           ORDER BY c.company_name""",
        (identifier, identifier, identifier, identifier),
    ).fetchall()
    if exact:
        return exact
    return connection.execute(
        """SELECT company_id, company_name
           FROM companies
           WHERE company_name LIKE ? COLLATE NOCASE
           ORDER BY company_name
           LIMIT 10""",
        (f"%{identifier}%",),
    ).fetchall()


def get_company(connection: sqlite3.Connection, company_id: str) -> dict[str, object]:
    company = connection.execute(
        "SELECT * FROM current_universe WHERE company_id = ?", (company_id,)
    ).fetchone()
    listings = connection.execute(
        """SELECT ticker, exchange, currency, security_type, lookup_symbol, is_primary
           FROM listings WHERE company_id = ? ORDER BY is_primary DESC, exchange, ticker""",
        (company_id,),
    ).fetchall()
    datapoints = connection.execute(
        """SELECT d.datapoint_key, d.label, d.value_type, d.unit,
                  v.as_of_date, v.numeric_value, v.text_value, v.source_note
           FROM latest_datapoints AS v
           JOIN datapoint_definitions AS d USING (datapoint_key)
           WHERE v.company_id = ? ORDER BY d.label""",
        (company_id,),
    ).fetchall()
    return {
        "company": dict(company),
        "listings": [dict(row) for row in listings],
        "datapoints": [dict(row) for row in datapoints],
    }


def print_datapoint(result: dict[str, object], key: str) -> int:
    company = result["company"]
    assert isinstance(company, dict)
    normalized = key.casefold()
    if normalized in {"market_cap", "market_cap_usd_bn", "market_cap_usd"}:
        print(
            f"{company['company_name']} ({company['primary_lookup_symbol']}): "
            f"${company['market_cap_usd_bn']:.2f}B as of {company['market_cap_as_of']}"
        )
        return 0

    datapoints = result["datapoints"]
    assert isinstance(datapoints, list)
    match = next(
        (item for item in datapoints if str(item["datapoint_key"]).casefold() == normalized),
        None,
    )
    if match is None:
        print(f"No value for '{key}' on {company['company_name']}.", file=sys.stderr)
        return 3
    value = match["numeric_value"] if match["numeric_value"] is not None else match["text_value"]
    unit = f" {match['unit']}" if match["unit"] else ""
    print(
        f"{company['company_name']} ({company['primary_lookup_symbol']}): "
        f"{match['label']} = {value}{unit} as of {match['as_of_date']}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identifier", help="Company name, company id, ticker, or lookup symbol")
    parser.add_argument("--datapoint", help="Return only this datapoint key")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    args = parser.parse_args()

    if not args.db.exists():
        print(f"Database not found: {args.db}. Run scripts/build_database.py first.", file=sys.stderr)
        return 1

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    matches = resolve_company(connection, args.identifier.strip())
    if not matches:
        print(f"No company or ticker matched '{args.identifier}'.", file=sys.stderr)
        return 2
    if len(matches) > 1:
        print("Multiple companies matched; use a ticker or company id:", file=sys.stderr)
        for row in matches:
            print(f"  {row['company_id']}: {row['company_name']}", file=sys.stderr)
        return 2

    result = get_company(connection, matches[0]["company_id"])
    connection.close()

    if args.datapoint:
        return print_datapoint(result, args.datapoint)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=True))
        return 0

    company = result["company"]
    assert isinstance(company, dict)
    print(f"{company['company_name']} ({company['primary_lookup_symbol']})")
    print(
        f"{company['country']} | {company['segment']} | {company['inclusion_tier']} | "
        f"{company['universe_status']}"
    )
    print(f"Screen market cap: ${company['market_cap_usd_bn']:.2f}B ({company['market_cap_as_of']})")
    if company["notes"]:
        print(f"Notes: {company['notes']}")
    print("Listings:")
    for listing in result["listings"]:
        marker = "primary" if listing["is_primary"] else listing["security_type"]
        print(f"  {listing['lookup_symbol']} | {listing['exchange']} | {marker}")
    datapoints = result["datapoints"]
    assert isinstance(datapoints, list)
    if datapoints:
        print("Datapoints:")
        for item in datapoints:
            value = item["numeric_value"] if item["numeric_value"] is not None else item["text_value"]
            unit = f" {item['unit']}" if item["unit"] else ""
            print(f"  {item['datapoint_key']}: {value}{unit} ({item['as_of_date']})")
    else:
        print("Datapoints: none added yet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

