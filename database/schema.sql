PRAGMA foreign_keys = ON;

CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE companies (
    company_id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    country TEXT NOT NULL,
    segment TEXT NOT NULL,
    inclusion_tier TEXT NOT NULL CHECK (inclusion_tier IN ('core', 'extended')),
    notes TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) WITHOUT ROWID;

CREATE TABLE listings (
    listing_id INTEGER PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    ticker TEXT NOT NULL COLLATE NOCASE,
    exchange TEXT NOT NULL COLLATE NOCASE,
    currency TEXT NOT NULL,
    security_type TEXT NOT NULL,
    lookup_symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    UNIQUE (ticker, exchange)
);

CREATE INDEX listings_company_idx ON listings(company_id);
CREATE INDEX listings_ticker_idx ON listings(ticker COLLATE NOCASE);

CREATE TABLE universe_screenings (
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    screening_date TEXT NOT NULL,
    market_cap_usd_bn REAL NOT NULL CHECK (market_cap_usd_bn > 0),
    threshold_usd_bn REAL NOT NULL CHECK (threshold_usd_bn > 0),
    universe_status TEXT NOT NULL CHECK (universe_status IN ('included', 'watchlist')),
    PRIMARY KEY (company_id, screening_date)
) WITHOUT ROWID;

CREATE INDEX screenings_date_idx ON universe_screenings(screening_date);
CREATE INDEX screenings_status_idx ON universe_screenings(universe_status);

CREATE TABLE datapoint_definitions (
    datapoint_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('numeric', 'text', 'date')),
    unit TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE datapoint_values (
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    datapoint_key TEXT NOT NULL REFERENCES datapoint_definitions(datapoint_key) ON DELETE CASCADE,
    as_of_date TEXT NOT NULL,
    numeric_value REAL,
    text_value TEXT,
    source_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, datapoint_key, as_of_date),
    CHECK (
        (numeric_value IS NOT NULL AND text_value IS NULL)
        OR (numeric_value IS NULL AND text_value IS NOT NULL)
    )
) WITHOUT ROWID;

CREATE INDEX datapoint_values_key_idx ON datapoint_values(datapoint_key, as_of_date);

CREATE VIEW current_universe AS
SELECT
    c.company_id,
    c.company_name,
    c.country,
    c.segment,
    c.inclusion_tier,
    s.universe_status,
    s.market_cap_usd_bn,
    s.screening_date AS market_cap_as_of,
    l.ticker AS primary_ticker,
    l.exchange AS primary_exchange,
    l.lookup_symbol AS primary_lookup_symbol,
    c.notes
FROM companies AS c
JOIN universe_screenings AS s
  ON s.company_id = c.company_id
 AND s.screening_date = (
     SELECT MAX(s2.screening_date)
     FROM universe_screenings AS s2
     WHERE s2.company_id = c.company_id
 )
JOIN listings AS l
  ON l.company_id = c.company_id
 AND l.is_primary = 1
WHERE c.active = 1;

CREATE VIEW latest_datapoints AS
SELECT dv.*
FROM datapoint_values AS dv
WHERE NOT EXISTS (
    SELECT 1
    FROM datapoint_values AS newer
    WHERE newer.company_id = dv.company_id
      AND newer.datapoint_key = dv.datapoint_key
      AND newer.as_of_date > dv.as_of_date
);
