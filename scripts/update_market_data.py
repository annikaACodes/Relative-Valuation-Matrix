#!/usr/bin/env python3
"""Refresh weekly market-cap, price, FX, and fiscal consensus inputs.

The update is transactional: every tracked quote must validate before any source
CSV is replaced. Calendarization and SQLite generation remain separate build
steps so the same deterministic calculations are used locally and in Actions.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import statistics
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
UNIVERSE_PATH = DATA_DIR / "semiconductor_universe.csv"
FORECAST_PATH = DATA_DIR / "fiscal_forecasts.csv"
VALUATION_PATH = DATA_DIR / "valuation_inputs.csv"
FX_PATH = DATA_DIR / "fx_rates.csv"
UPDATE_STATUS_PATH = DATA_DIR / "update_status.json"

MARKET_CAP_THRESHOLD_USD_BN = Decimal("15")
TARGET_CALENDAR_YEARS = {2027, 2028}
MIN_FISCAL_YEAR = 2024
MAX_FISCAL_YEAR = 2030
DEFAULT_TIMEZONE = "America/New_York"
DEFAULT_WORKERS = 4
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36 "
    "RelativeValuationMatrix/1.0"
)
FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates"
OPEN_ER_URL = "https://open.er-api.com/v6/latest/USD"

FORECAST_COLUMNS = [
    "company_id",
    "fiscal_year",
    "fiscal_period",
    "reporting_currency",
    "net_income",
    "income_scale",
    "ebitda",
    "fcf",
    "fcf_scale",
    "net_debt",
    "net_debt_scale",
    "diluted_shares_thousands",
    "source_eps",
    "share_source_method",
    "source_url",
    "source_retrieved_at",
]


class UpdateError(RuntimeError):
    """Raised when a source response cannot be trusted for publication."""


@dataclass
class Cell:
    pieces: list[str] = field(default_factory=list)
    titles: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return squish(" ".join(self.pieces))


class MarketPageParser(HTMLParser):
    """Collect the small subset of page structure needed by the updater."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[Cell]]] = []
        self.json_scripts: list[str] = []
        self.market_caps: dict[str, str] = {}

        self._table_depth = 0
        self._table: list[list[Cell]] | None = None
        self._row: list[Cell] | None = None
        self._cell: Cell | None = None
        self._capture_json = False
        self._json_parts: list[str] = []

        self._in_row = False
        self._market_cap_row = False
        self._row_currency_values: dict[str, str] = {}
        self._currency_stack: list[str | None] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}

        if tag == "script" and attributes.get("type", "").casefold() == "application/ld+json":
            self._capture_json = True
            self._json_parts = []

        if tag == "table":
            if self._table_depth == 0:
                self._table = []
            self._table_depth += 1

        if tag == "tr":
            self._in_row = True
            self._market_cap_row = False
            self._row_currency_values = {}
            if self._table_depth == 1:
                self._row = []

        if tag in {"td", "th"} and self._table_depth == 1 and self._row is not None:
            self._cell = Cell()

        if self._cell is not None and attributes.get("title"):
            self._cell.titles.append(attributes["title"])

        if tag == "span" and self._in_row:
            inherited = self._currency_stack[-1] if self._currency_stack else None
            class_name = attributes.get("class", "")
            match = re.search(r"(?:^|\s)efd_([A-Z]{3})(?:\s|$)", class_name)
            currency = match.group(1) if match else inherited
            self._currency_stack.append(currency)
            if currency and attributes.get("title"):
                self._row_currency_values[currency] = attributes["title"]

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._capture_json:
            self.json_scripts.append("".join(self._json_parts).strip())
            self._capture_json = False
            self._json_parts = []

        if tag in {"td", "th"} and self._cell is not None:
            if self._row is not None:
                self._row.append(self._cell)
            self._cell = None

        if tag == "tr":
            if self._table_depth == 1 and self._table is not None and self._row:
                self._table.append(self._row)
            if self._market_cap_row and "USD" in self._row_currency_values:
                self.market_caps.update(self._row_currency_values)
            self._row = None
            self._in_row = False
            self._market_cap_row = False
            self._row_currency_values = {}
            self._currency_stack = []

        if tag == "table" and self._table_depth:
            self._table_depth -= 1
            if self._table_depth == 0 and self._table is not None:
                self.tables.append(self._table)
                self._table = None

        if tag == "span" and self._currency_stack:
            self._currency_stack.pop()

    def handle_data(self, data: str) -> None:
        if self._capture_json:
            self._json_parts.append(data)
        if self._cell is not None:
            self._cell.pieces.append(data)
        if self._in_row and squish(data).casefold() == "market cap":
            self._market_cap_row = True


@dataclass(frozen=True)
class QuoteSnapshot:
    price: str
    price_currency: str
    market_cap_usd_bn: str
    market_caps: dict[str, Decimal]


@dataclass(frozen=True)
class ForecastSnapshot:
    rows: list[dict[str, str]]
    reporting_currency: str
    target_value_count: int


@dataclass(frozen=True)
class CompanySnapshot:
    company_id: str
    quote: QuoteSnapshot
    forecast: ForecastSnapshot | None
    fallback_shares_outstanding: Decimal | None


@dataclass(frozen=True)
class FxRate:
    currency: str
    usd_per_currency: Decimal
    source_url: str
    calculation: str
    source_note: str


def squish(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split())


def read_csv(path: Path) -> tuple[list[dict[str, str]], list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise UpdateError(f"Missing CSV header: {path}")
        rows = [
            {key: (value or "").strip() for key, value in row.items()}
            for row in reader
            if any((value or "").strip() for value in row.values())
        ]
        return rows, list(reader.fieldnames)


def write_csv_atomic(path: Path, rows: Iterable[dict[str, str]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="", delete=False, dir=path.parent, suffix=".tmp"
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="", delete=False, dir=path.parent, suffix=".tmp"
    ) as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def request_text(url: str, attempts: int = 3, timeout: int = 35) -> str:
    error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Cache-Control": "no-cache",
                },
            )
            with urlopen(request, timeout=timeout) as response:
                content = response.read()
                charset = response.headers.get_content_charset() or "utf-8"
            text = content.decode(charset, errors="replace")
            if len(text) < 100:
                raise UpdateError(f"Response was unexpectedly short ({len(text)} bytes)")
            return text
        except (HTTPError, URLError, TimeoutError, UpdateError) as exc:
            error = exc
            if attempt < attempts:
                time.sleep(2 ** (attempt - 1))
    raise UpdateError(f"Could not fetch {url}: {error}")


def parse_decimal(value: str | int | float | Decimal | None) -> Decimal | None:
    if value is None:
        return None
    text = squish(str(value)).replace(",", "").replace("\u2212", "-")
    if not text or text in {"-", "--", "N/A", "n/a"}:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    multiplier = Decimal(1)
    suffix = text[-1:].upper()
    if suffix in {"K", "M", "B", "T"}:
        multiplier = {
            "K": Decimal(1_000),
            "M": Decimal(1_000_000),
            "B": Decimal(1_000_000_000),
            "T": Decimal(1_000_000_000_000),
        }[suffix]
        text = text[:-1]
    text = text.removesuffix("x").removesuffix("%").strip()
    try:
        result = Decimal(text) * multiplier
    except InvalidOperation:
        return None
    return -result if negative else result


def decimal_text(value: Decimal | None, places: int | None = None) -> str:
    if value is None:
        return ""
    if places is not None:
        return f"{value:.{places}f}"
    normalized = format(value, "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    return normalized or "0"


def canonical_number(value: str) -> str:
    return decimal_text(parse_decimal(value))


def parse_json_document(raw: str) -> Any | None:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def find_offer(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        offers = value.get("offers")
        if isinstance(offers, dict) and offers.get("price") is not None and offers.get("priceCurrency"):
            return offers
        for child in value.values():
            result = find_offer(child)
            if result:
                return result
    elif isinstance(value, list):
        for child in value:
            result = find_offer(child)
            if result:
                return result
    return None


def parse_quote_page(page: str, company_id: str) -> QuoteSnapshot:
    parser = MarketPageParser()
    parser.feed(page)

    offer = None
    for raw_script in parser.json_scripts:
        document = parse_json_document(raw_script)
        offer = find_offer(document)
        if offer:
            break
    if not offer:
        raise UpdateError(f"{company_id}: quote price JSON-LD was not found")

    price_value = parse_decimal(offer.get("price"))
    price_currency = str(offer.get("priceCurrency", "")).upper()
    if price_value is None or price_value <= 0 or not re.fullmatch(r"[A-Z]{3}", price_currency):
        raise UpdateError(f"{company_id}: invalid price or price currency")

    market_caps = {
        currency: value
        for currency, raw_value in parser.market_caps.items()
        if (value := parse_decimal(raw_value)) is not None and value > 0
    }
    market_cap_usd = market_caps.get("USD")
    market_cap_usd_bn = ""
    if market_cap_usd is not None and market_cap_usd >= Decimal(1_000_000_000):
        market_cap_usd_bn = decimal_text(market_cap_usd / Decimal(1_000_000_000), 2)

    return QuoteSnapshot(
        price=decimal_text(price_value),
        price_currency=price_currency,
        market_cap_usd_bn=market_cap_usd_bn,
        market_caps=market_caps,
    )


def normalized_row_label(value: str) -> str:
    return re.sub(r"\s+\d+$", "", squish(value)).casefold()


def row_key(label: str) -> str | None:
    if label == "net income":
        return "net_income"
    if label == "ebitda":
        return "ebitda"
    if label == "net debt":
        return "net_debt"
    if label.startswith("free cash flow (fcf)"):
        return "fcf"
    if label == "eps":
        return "source_eps"
    if label.startswith("nbr of stocks (in thousands)"):
        return "diluted_shares_thousands"
    return None


def currency_and_scale(titles: Iterable[str]) -> tuple[str, str]:
    for title in titles:
        match = re.search(
            r"\b([A-Z]{3})\s+in\s+(Thousands?|Millions?|Billions?)\b", title
        )
        if match:
            return match.group(1), match.group(2).removesuffix("s")
        scale_only = re.search(r"\bin\s+(Thousands?|Millions?|Billions?)\b", title)
        if scale_only:
            return "", scale_only.group(1).removesuffix("s")
    for title in titles:
        if re.fullmatch(r"[A-Z]{3}", squish(title)):
            return squish(title), ""
    return "", ""


def parse_forecast_page(
    page: str,
    company_id: str,
    source_url: str,
    as_of: str,
    previous_rows: list[dict[str, str]],
    fallback_reporting_currency: str = "",
) -> ForecastSnapshot:
    parser = MarketPageParser()
    parser.feed(page)

    series: dict[str, dict[int, str]] = {}
    series_units: dict[str, tuple[str, str]] = {}
    fiscal_period = ""

    for table in parser.tables:
        if len(table) < 2 or not table[0]:
            continue
        header = table[0]
        header_label = header[0].text
        if not header_label.casefold().startswith("fiscal period:"):
            continue
        if any(re.search(r"\bQ[1-4]\b", cell.text) for cell in header[1:]):
            continue

        year_columns: list[tuple[int, int]] = []
        for index, cell in enumerate(header[1:], start=1):
            match = re.fullmatch(r"(20\d{2})(?:\s*\*)?", cell.text)
            if match:
                year_columns.append((index, int(match.group(1))))
        if not year_columns:
            continue

        table_period = squish(header_label.split(":", 1)[1])
        if fiscal_period and table_period and fiscal_period != table_period:
            raise UpdateError(f"{company_id}: inconsistent fiscal periods in forecast tables")
        fiscal_period = table_period or fiscal_period

        for row in table[1:]:
            if not row:
                continue
            key = row_key(normalized_row_label(row[0].text))
            if key is None or key in series:
                continue
            values: dict[int, str] = {}
            for column_index, year in year_columns:
                value = row[column_index].text if column_index < len(row) else ""
                values[year] = canonical_number(value)
            series[key] = values
            series_units[key] = currency_and_scale(row[0].titles)

    required = {
        "net_income",
        "ebitda",
        "net_debt",
        "fcf",
        "source_eps",
        "diluted_shares_thousands",
    }
    missing = sorted(required - set(series))
    if missing:
        raise UpdateError(f"{company_id}: missing forecast series: {', '.join(missing)}")
    if not fiscal_period:
        raise UpdateError(f"{company_id}: fiscal period was not found")

    previous_periods = {row["fiscal_period"] for row in previous_rows if row.get("fiscal_period")}
    if previous_periods and fiscal_period not in previous_periods:
        raise UpdateError(
            f"{company_id}: fiscal period changed from {sorted(previous_periods)} to {fiscal_period}"
        )

    amount_keys = ("net_income", "ebitda", "net_debt", "fcf")
    currencies = {series_units[key][0] for key in amount_keys if series_units[key][0]}
    if len(currencies) > 1:
        raise UpdateError(f"{company_id}: inconsistent or missing reporting currency: {sorted(currencies)}")
    reporting_currency = currencies.pop() if currencies else fallback_reporting_currency
    if not re.fullmatch(r"[A-Z]{3}", reporting_currency):
        raise UpdateError(f"{company_id}: reporting currency was not found")

    old_income_scale = next((row.get("income_scale", "") for row in previous_rows if row.get("income_scale")), "")
    old_fcf_scale = next((row.get("fcf_scale", "") for row in previous_rows if row.get("fcf_scale")), "")
    old_net_debt_scale = next(
        (row.get("net_debt_scale", "") for row in previous_rows if row.get("net_debt_scale")), ""
    )
    income_scale = series_units["net_income"][1] or series_units["ebitda"][1] or old_income_scale
    ebitda_scale = series_units["ebitda"][1] or income_scale
    if not income_scale or ebitda_scale != income_scale:
        raise UpdateError(f"{company_id}: inconsistent income-statement scales")
    fcf_scale = series_units["fcf"][1] or old_fcf_scale or income_scale
    net_debt_scale = series_units["net_debt"][1] or old_net_debt_scale or income_scale
    if not fcf_scale or not net_debt_scale:
        raise UpdateError(f"{company_id}: missing FCF or net-debt scale")

    for key in required:
        for year in TARGET_CALENDAR_YEARS:
            series[key].setdefault(year, "")

    target_value_count = sum(
        bool(series[key].get(year)) for key in required for year in TARGET_CALENDAR_YEARS
    )
    old_target_count = sum(
        bool(row.get(key))
        for row in previous_rows
        if int(row["fiscal_year"]) in TARGET_CALENDAR_YEARS
        for key in required
    )
    if old_target_count >= 6 and target_value_count < max(3, old_target_count // 2):
        raise UpdateError(
            f"{company_id}: target-year coverage fell from {old_target_count} to {target_value_count} values"
        )

    available_years = set().union(*(values.keys() for values in series.values())) | TARGET_CALENDAR_YEARS
    all_years = sorted(
        year for year in available_years if MIN_FISCAL_YEAR <= year <= MAX_FISCAL_YEAR
    )
    rows = []
    for year in all_years:
        rows.append(
            {
                "company_id": company_id,
                "fiscal_year": str(year),
                "fiscal_period": fiscal_period,
                "reporting_currency": reporting_currency,
                "net_income": series["net_income"].get(year, ""),
                "income_scale": income_scale,
                "ebitda": series["ebitda"].get(year, ""),
                "fcf": series["fcf"].get(year, ""),
                "fcf_scale": fcf_scale,
                "net_debt": series["net_debt"].get(year, ""),
                "net_debt_scale": net_debt_scale,
                "diluted_shares_thousands": series["diluted_shares_thousands"].get(year, ""),
                "source_eps": series["source_eps"].get(year, ""),
                "share_source_method": "published diluted share count",
                "source_url": source_url,
                "source_retrieved_at": as_of,
            }
        )
    if not rows:
        raise UpdateError(f"{company_id}: no usable annual forecast rows")
    return ForecastSnapshot(rows, reporting_currency, target_value_count)


def parse_latest_shares_outstanding(page: str) -> Decimal | None:
    parser = MarketPageParser()
    parser.feed(page)
    preferred_labels = (
        "ecs total common shares outstanding",
        "ecs total shares outstanding on filing date",
        "basic weighted average shares outstanding",
        "diluted weighted average shares outstanding",
    )
    candidates: dict[str, Decimal] = {}
    for table in parser.tables:
        for row in table[1:]:
            if not row:
                continue
            label = normalized_row_label(row[0].text)
            if label not in preferred_labels:
                continue
            values = [parse_decimal(cell.text) for cell in row[1:]]
            usable = [value for value in values if value is not None and value > 0]
            if usable:
                candidates[label] = usable[-1]
    return next((candidates[label] for label in preferred_labels if label in candidates), None)


def validate_market_cap_change(company_id: str, old_value: str, new_value: str) -> None:
    old = parse_decimal(old_value)
    new = parse_decimal(new_value)
    if old is None or new is None or old <= 0 or new <= 0:
        raise UpdateError(f"{company_id}: invalid old or new market capitalization")
    ratio = new / old
    if ratio < Decimal("0.25") or ratio > Decimal("4"):
        raise UpdateError(
            f"{company_id}: market capitalization changed implausibly from {old}B to {new}B"
        )


def fetch_company_snapshot(
    company: dict[str, str],
    valuation: dict[str, str],
    previous_rows: list[dict[str, str]],
    as_of: str,
) -> CompanySnapshot:
    company_id = company["company_id"]
    quote_url = valuation["price_source_url"]
    forecast_url = valuation["forecast_source_url"]
    if not quote_url or not forecast_url:
        raise UpdateError(f"{company_id}: missing quote or forecast source URL")

    quote_page = request_text(quote_url)
    quote = parse_quote_page(quote_page, company_id)
    if quote.market_cap_usd_bn:
        validate_market_cap_change(company_id, company["market_cap_usd_bn"], quote.market_cap_usd_bn)

    forecast_page = request_text(forecast_url)
    try:
        forecast = parse_forecast_page(
            forecast_page,
            company_id,
            forecast_url,
            as_of,
            previous_rows,
            valuation.get("reporting_currency", ""),
        )
    except UpdateError as exc:
        expected_gap = any(
            marker in str(exc)
            for marker in ("missing forecast series", "fiscal period was not found")
        )
        if valuation.get("input_status") != "no_forward_consensus" or not expected_gap:
            raise
        forecast = None
    fallback_shares = None
    if not quote.market_cap_usd_bn:
        old_price = parse_decimal(valuation.get("price"))
        can_roll_forward = (
            old_price is not None
            and old_price > 0
            and valuation.get("price_currency") == quote.price_currency
        )
        if not can_roll_forward:
            fallback_shares = parse_latest_shares_outstanding(forecast_page)
            if fallback_shares is None:
                raise UpdateError(
                    f"{company_id}: market cap is unavailable and no share-count fallback was found"
                )
    return CompanySnapshot(company_id, quote, forecast, fallback_shares)


def implied_fx_rates(snapshots: Iterable[CompanySnapshot]) -> dict[str, Decimal]:
    observations: dict[str, list[Decimal]] = {}
    for snapshot in snapshots:
        usd_market_cap = snapshot.quote.market_caps.get("USD")
        if usd_market_cap is None:
            continue
        for currency, market_cap in snapshot.quote.market_caps.items():
            if currency == "USD" or market_cap <= 0:
                continue
            observations.setdefault(currency, []).append(usd_market_cap / market_cap)
    return {
        currency: Decimal(str(statistics.median(float(value) for value in values)))
        for currency, values in observations.items()
        if values
    }


def fetch_frankfurter_rates(currencies: set[str]) -> dict[str, FxRate]:
    requested = sorted(currency for currency in currencies if currency not in {"USD", "TWD"})
    if not requested:
        return {}
    url = f"{FRANKFURTER_URL}?{urlencode({'base': 'USD', 'quotes': ','.join(requested)})}"
    data = json.loads(request_text(url))
    if not isinstance(data, list):
        raise UpdateError("Frankfurter returned an unexpected response")
    rates: dict[str, FxRate] = {}
    for item in data:
        currency = str(item.get("quote", "")).upper()
        quote_per_usd = parse_decimal(item.get("rate"))
        if currency in requested and quote_per_usd is not None and quote_per_usd > 0:
            source_date = str(item.get("date", ""))
            rates[currency] = FxRate(
                currency,
                Decimal(1) / quote_per_usd,
                url,
                "1 / Frankfurter USD reference quote",
                f"Frankfurter reference rate dated {source_date}",
            )
    return rates


def fetch_twd_rate() -> FxRate:
    data = json.loads(request_text(OPEN_ER_URL))
    quote_per_usd = parse_decimal(data.get("rates", {}).get("TWD"))
    if data.get("result") != "success" or quote_per_usd is None or quote_per_usd <= 0:
        raise UpdateError("ExchangeRate-API returned no usable TWD rate")
    source_date = str(data.get("time_last_update_utc", ""))
    return FxRate(
        "TWD",
        Decimal(1) / quote_per_usd,
        OPEN_ER_URL,
        "1 / ExchangeRate-API USD quote",
        f"TWD reference rate updated {source_date}",
    )


def build_fx_rates(
    currencies: set[str], snapshots: list[CompanySnapshot]
) -> dict[str, FxRate]:
    implied = implied_fx_rates(snapshots)
    rates: dict[str, FxRate] = {
        "USD": FxRate("USD", Decimal(1), "", "identity", "USD-reported values require no conversion")
    }

    try:
        rates.update(fetch_frankfurter_rates(currencies))
    except (UpdateError, json.JSONDecodeError) as exc:
        print(f"Warning: Frankfurter unavailable; using quote-page implied FX where possible: {exc}")

    if "TWD" in currencies:
        try:
            rates["TWD"] = fetch_twd_rate()
        except (UpdateError, json.JSONDecodeError) as exc:
            print(f"Warning: TWD reference source unavailable; using implied FX: {exc}")

    for currency in sorted(currencies - set(rates)):
        implied_rate = implied.get(currency)
        if implied_rate is None:
            raise UpdateError(f"No USD conversion rate is available for {currency}")
        rates[currency] = FxRate(
            currency,
            implied_rate,
            "https://www.marketscreener.com/",
            "USD market cap / local-currency market cap",
            "Median implied MarketScreener quote-page conversion",
        )

    for currency, rate in rates.items():
        implied_rate = implied.get(currency)
        if currency == "USD" or implied_rate is None:
            continue
        difference = abs(rate.usd_per_currency / implied_rate - Decimal(1))
        if difference > Decimal("0.05"):
            raise UpdateError(
                f"{currency}: reference FX differs from quote-page implied FX by {difference:.1%}"
            )
    return rates


def build_outputs(
    universe: list[dict[str, str]],
    universe_columns: list[str],
    valuations: list[dict[str, str]],
    valuation_columns: list[str],
    prior_forecasts: list[dict[str, str]],
    prior_fx_rows: list[dict[str, str]],
    snapshots: list[CompanySnapshot],
    as_of: str,
) -> tuple[
    list[dict[str, str]],
    list[dict[str, str]],
    list[dict[str, str]],
    list[dict[str, str]],
    dict[str, Any],
]:
    snapshots_by_id = {snapshot.company_id: snapshot for snapshot in snapshots}
    valuations_by_id = {row["company_id"]: row for row in valuations}
    prior_by_id: dict[str, list[dict[str, str]]] = {}
    for row in prior_forecasts:
        prior_by_id.setdefault(row["company_id"], []).append(row)

    currencies = {"USD"}
    for snapshot in snapshots:
        currencies.add(snapshot.quote.price_currency)
        if snapshot.forecast:
            currencies.add(snapshot.forecast.reporting_currency)
        else:
            previous_currency = valuations_by_id[snapshot.company_id].get("reporting_currency")
            if previous_currency:
                currencies.add(previous_currency)
    fx_rates = build_fx_rates(currencies, snapshots)
    old_fx_by_currency: dict[str, tuple[str, Decimal]] = {"USD": ("", Decimal(1))}
    for row in sorted(prior_fx_rows, key=lambda item: item["rate_date"]):
        value = parse_decimal(row.get("usd_per_currency"))
        if value is not None and value > 0:
            old_fx_by_currency[row["currency"]] = (row["rate_date"], value)

    updated_universe: list[dict[str, str]] = []
    updated_valuations: list[dict[str, str]] = []
    updated_forecasts: list[dict[str, str]] = []
    forecast_page_count = 0
    no_consensus_count = 0
    derived_market_cap_count = 0
    share_derived_market_cap_count = 0

    for company in universe:
        company_id = company["company_id"]
        snapshot = snapshots_by_id[company_id]
        valuation = dict(valuations_by_id[company_id])

        market_cap_usd_bn = snapshot.quote.market_cap_usd_bn
        if not market_cap_usd_bn:
            old_price = parse_decimal(valuation.get("price"))
            new_price = parse_decimal(snapshot.quote.price)
            old_market_cap = parse_decimal(company.get("market_cap_usd_bn"))
            old_fx = old_fx_by_currency.get(snapshot.quote.price_currency, ("", Decimal(0)))[1]
            new_fx = fx_rates[snapshot.quote.price_currency].usd_per_currency
            can_roll_forward = (
                None not in {old_price, new_price, old_market_cap}
                and old_fx > 0
                and valuation.get("price_currency") == snapshot.quote.price_currency
            )
            if can_roll_forward:
                derived_market_cap = old_market_cap * (new_price * new_fx) / (old_price * old_fx)
            elif new_price is not None and snapshot.fallback_shares_outstanding is not None:
                derived_market_cap = (
                    new_price * snapshot.fallback_shares_outstanding * new_fx / Decimal(1_000_000_000)
                )
                share_derived_market_cap_count += 1
            else:
                raise UpdateError(f"{company_id}: cannot derive a current USD market capitalization")
            market_cap_usd_bn = decimal_text(derived_market_cap, 2)
            derived_market_cap_count += 1
        validate_market_cap_change(company_id, company["market_cap_usd_bn"], market_cap_usd_bn)

        updated_company = dict(company)
        updated_company["market_cap_usd_bn"] = market_cap_usd_bn
        updated_company["market_cap_as_of"] = as_of
        updated_company["universe_status"] = (
            "included"
            if Decimal(market_cap_usd_bn) > MARKET_CAP_THRESHOLD_USD_BN
            else "watchlist"
        )
        updated_universe.append(updated_company)

        forecast = snapshot.forecast
        if forecast:
            reporting_currency = forecast.reporting_currency
            updated_forecasts.extend(forecast.rows)
            forecast_page_count += 1
            input_status = "available" if forecast.target_value_count else "no_forward_consensus"
            if not forecast.target_value_count:
                no_consensus_count += 1
        else:
            reporting_currency = valuation.get("reporting_currency", "")
            updated_forecasts.extend(prior_by_id.get(company_id, []))
            input_status = "no_forward_consensus"
            no_consensus_count += 1

        valuation["valuation_date"] = as_of
        valuation["price"] = snapshot.quote.price
        valuation["price_currency"] = snapshot.quote.price_currency
        valuation["input_status"] = input_status
        valuation["reporting_currency"] = reporting_currency
        if reporting_currency:
            price_rate = fx_rates[snapshot.quote.price_currency].usd_per_currency
            reporting_rate = fx_rates[reporting_currency].usd_per_currency
            conversion = price_rate / reporting_rate
            valuation["price_to_reporting_fx"] = decimal_text(conversion)
            source_urls = [
                fx_rates[snapshot.quote.price_currency].source_url,
                fx_rates[reporting_currency].source_url,
            ]
            valuation["fx_source_url"] = "" if conversion == 1 else next(
                (url for url in source_urls if url), ""
            )
        else:
            valuation["price_to_reporting_fx"] = ""
            valuation["fx_source_url"] = ""
        updated_valuations.append(valuation)

    company_order = {row["company_id"]: index for index, row in enumerate(universe)}
    updated_forecasts.sort(key=lambda row: (company_order[row["company_id"]], int(row["fiscal_year"])))

    fx_rows = [
        {
            "rate_date": as_of,
            "currency": currency,
            "usd_per_currency": decimal_text(rate.usd_per_currency),
            "calculation": rate.calculation,
            "source_url": rate.source_url,
            "source_note": rate.source_note,
        }
        for currency, rate in sorted(fx_rates.items())
    ]
    status = {
        "as_of_date": as_of,
        "companies_tracked": len(universe),
        "forecast_pages_updated": forecast_page_count,
        "market_caps_updated": len(updated_universe),
        "market_caps_derived": derived_market_cap_count,
        "market_caps_share_count_derived": share_derived_market_cap_count,
        "no_forward_consensus": no_consensus_count,
        "schedule": "Sunday 00:00 America/New_York",
        "source": "MarketScreener analyst forecast and quote pages",
    }
    return updated_universe, updated_valuations, updated_forecasts, fx_rows, status


def select_companies(
    universe: list[dict[str, str]], requested: list[str]
) -> list[dict[str, str]]:
    if not requested:
        return universe
    requested_set = set(requested)
    unknown = requested_set - {row["company_id"] for row in universe}
    if unknown:
        raise UpdateError(f"Unknown company id(s): {', '.join(sorted(unknown))}")
    return [row for row in universe if row["company_id"] in requested_set]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--company", action="append", default=[], help="Refresh one company in dry-run mode")
    parser.add_argument("--date", help="Override the America/New_York as-of date (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and validate without writing files")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.company and not args.dry_run:
        raise UpdateError("--company is only supported together with --dry-run")
    if args.workers < 1 or args.workers > 8:
        raise UpdateError("--workers must be between 1 and 8")

    now = datetime.now(ZoneInfo(DEFAULT_TIMEZONE))
    as_of = args.date or now.date().isoformat()
    datetime.strptime(as_of, "%Y-%m-%d")

    universe, universe_columns = read_csv(UNIVERSE_PATH)
    valuations, valuation_columns = read_csv(VALUATION_PATH)
    prior_forecasts, _ = read_csv(FORECAST_PATH)
    prior_fx_rows, _ = read_csv(FX_PATH)
    if len(universe) != 104 or len(valuations) != 104:
        raise UpdateError("The updater expects exactly 104 universe and valuation rows")

    valuations_by_id = {row["company_id"]: row for row in valuations}
    forecasts_by_id: dict[str, list[dict[str, str]]] = {}
    for row in prior_forecasts:
        forecasts_by_id.setdefault(row["company_id"], []).append(row)
    selected = select_companies(universe, args.company)

    print(f"Fetching {len(selected)} companies for {as_of} with {args.workers} workers")
    snapshots: list[CompanySnapshot] = []
    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                fetch_company_snapshot,
                company,
                valuations_by_id[company["company_id"]],
                forecasts_by_id.get(company["company_id"], []),
                as_of,
            ): company["company_id"]
            for company in selected
        }
        for future in as_completed(futures):
            company_id = futures[future]
            try:
                snapshot = future.result()
                snapshots.append(snapshot)
                forecast_status = "forecast parsed" if snapshot.forecast else "no forward consensus"
                market_cap_status = (
                    f"${snapshot.quote.market_cap_usd_bn}B"
                    if snapshot.quote.market_cap_usd_bn
                    else "price-derived market cap"
                )
                print(
                    f"  {company_id}: {market_cap_status}, "
                    f"{snapshot.quote.price} {snapshot.quote.price_currency}, {forecast_status}"
                )
            except Exception as exc:  # The aggregate error is easier to act on in Actions logs.
                failures.append(f"{company_id}: {exc}")

    if failures:
        details = "\n".join(f"  - {failure}" for failure in sorted(failures))
        raise UpdateError(f"Weekly refresh aborted; no files were changed:\n{details}")
    universe_order = {row["company_id"]: index for index, row in enumerate(universe)}
    snapshots.sort(key=lambda item: universe_order[item.company_id])

    if args.dry_run:
        if not args.company:
            build_outputs(
                universe,
                universe_columns,
                valuations,
                valuation_columns,
                prior_forecasts,
                prior_fx_rows,
                snapshots,
                as_of,
            )
        print("Dry run passed; no files were changed")
        return 0

    if len(snapshots) != len(universe):
        raise UpdateError("A publication run must validate every tracked company")
    updated_universe, updated_valuations, updated_forecasts, fx_rows, status = build_outputs(
        universe,
        universe_columns,
        valuations,
        valuation_columns,
        prior_forecasts,
        prior_fx_rows,
        snapshots,
        as_of,
    )

    write_csv_atomic(UNIVERSE_PATH, updated_universe, universe_columns)
    write_csv_atomic(VALUATION_PATH, updated_valuations, valuation_columns)
    write_csv_atomic(FORECAST_PATH, updated_forecasts, FORECAST_COLUMNS)
    write_csv_atomic(
        FX_PATH,
        fx_rows,
        ["rate_date", "currency", "usd_per_currency", "calculation", "source_url", "source_note"],
    )
    write_json_atomic(UPDATE_STATUS_PATH, status)
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (UpdateError, ValueError) as exc:
        print(f"ERROR: {exc}")
        raise SystemExit(1) from exc
