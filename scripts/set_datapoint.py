#!/usr/bin/env python3
"""Add or replace a datapoint in the CSV source of truth and rebuild SQLite."""

from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "relative_valuation.sqlite"
DEFINITIONS_PATH = DATA_DIR / "datapoint_definitions.csv"
VALUES_PATH = DATA_DIR / "datapoint_values.csv"
DEFINITION_FIELDS = ["datapoint_key", "label", "value_type", "unit", "description"]
VALUE_FIELDS = [
    "company_id", "datapoint_key", "as_of_date", "numeric_value", "text_value", "source_note"
]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def write_csv_atomic(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    descriptor, temp_name = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temp_name, path)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise


def resolve_company(identifier: str) -> tuple[str, str]:
    if not DB_PATH.exists():
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build_database.py")], check=True)
    connection = sqlite3.connect(DB_PATH)
    rows = connection.execute(
        """SELECT DISTINCT c.company_id, c.company_name
           FROM companies AS c LEFT JOIN listings AS l ON l.company_id = c.company_id
           WHERE c.company_id = ? COLLATE NOCASE OR c.company_name = ? COLLATE NOCASE
              OR l.ticker = ? COLLATE NOCASE OR l.lookup_symbol = ? COLLATE NOCASE""",
        (identifier, identifier, identifier, identifier),
    ).fetchall()
    connection.close()
    if len(rows) != 1:
        raise ValueError(f"Expected exactly one company match for '{identifier}'; found {len(rows)}")
    return rows[0][0], rows[0][1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identifier", help="Company id, exact company name, ticker, or lookup symbol")
    parser.add_argument("datapoint_key")
    parser.add_argument("value")
    parser.add_argument("--as-of", default=date.today().isoformat())
    parser.add_argument("--type", choices=("numeric", "text", "date"), default="numeric")
    parser.add_argument("--label")
    parser.add_argument("--unit", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--source-note", default="")
    args = parser.parse_args()

    date.fromisoformat(args.as_of)
    if args.type == "numeric":
        numeric_value = str(float(args.value))
        text_value = ""
    else:
        if args.type == "date":
            date.fromisoformat(args.value)
        numeric_value = ""
        text_value = args.value

    company_id, company_name = resolve_company(args.identifier.strip())
    definitions = read_csv(DEFINITIONS_PATH)
    existing_definition = next(
        (row for row in definitions if row["datapoint_key"] == args.datapoint_key), None
    )
    if existing_definition:
        if existing_definition["value_type"] != args.type:
            raise ValueError(
                f"{args.datapoint_key} is already type {existing_definition['value_type']}"
            )
    else:
        definitions.append(
            {
                "datapoint_key": args.datapoint_key,
                "label": args.label or args.datapoint_key.replace("_", " ").title(),
                "value_type": args.type,
                "unit": args.unit,
                "description": args.description,
            }
        )
        definitions.sort(key=lambda row: row["datapoint_key"])

    values = read_csv(VALUES_PATH)
    replacement_key = (company_id, args.datapoint_key, args.as_of)
    replacement = {
        "company_id": company_id,
        "datapoint_key": args.datapoint_key,
        "as_of_date": args.as_of,
        "numeric_value": numeric_value,
        "text_value": text_value,
        "source_note": args.source_note,
    }
    values = [
        row for row in values
        if (row["company_id"], row["datapoint_key"], row["as_of_date"]) != replacement_key
    ]
    values.append(replacement)
    values.sort(key=lambda row: (row["company_id"], row["datapoint_key"], row["as_of_date"]))

    write_csv_atomic(DEFINITIONS_PATH, DEFINITION_FIELDS, definitions)
    write_csv_atomic(VALUES_PATH, VALUE_FIELDS, values)
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build_database.py")], check=True)
    print(f"Set {args.datapoint_key} for {company_name} as of {args.as_of}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
