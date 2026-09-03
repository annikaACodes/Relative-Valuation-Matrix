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
    preferred_ticker TEXT NOT NULL COLLATE NOCASE,
    fiscal_year_is_calendar INTEGER NOT NULL CHECK (fiscal_year_is_calendar IN (0, 1)),
    fiscal_year_end TEXT NOT NULL,
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

CREATE TABLE fiscal_forecasts (
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    fiscal_year INTEGER NOT NULL,
    fiscal_period TEXT NOT NULL,
    reporting_currency TEXT NOT NULL,
    net_income REAL,
    income_scale TEXT,
    ebitda REAL,
    fcf REAL,
    fcf_scale TEXT,
    net_debt REAL,
    net_debt_scale TEXT,
    diluted_shares_thousands REAL,
    source_eps REAL,
    share_source_method TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_retrieved_at TEXT NOT NULL,
    PRIMARY KEY (company_id, fiscal_year)
) WITHOUT ROWID;

CREATE TABLE valuation_inputs (
    company_id TEXT PRIMARY KEY REFERENCES companies(company_id) ON DELETE CASCADE,
    valuation_date TEXT NOT NULL,
    price REAL,
    price_currency TEXT,
    price_source_url TEXT,
    forecast_source_url TEXT,
    input_status TEXT NOT NULL,
    reporting_currency TEXT,
    price_to_reporting_fx REAL,
    fx_source_url TEXT
) WITHOUT ROWID;

CREATE TABLE calendarized_metrics (
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    calendar_year INTEGER NOT NULL,
    reporting_currency TEXT,
    fiscal_year_weight REAL NOT NULL,
    next_fiscal_year_weight REAL NOT NULL,
    eps REAL,
    fcf_per_share REAL,
    pe REAL,
    ev_to_fcf REAL,
    net_leverage REAL,
    calculation_quality TEXT NOT NULL CHECK (calculation_quality IN ('direct', 'flat-tail', 'partial')),
    tail_imputed INTEGER NOT NULL CHECK (tail_imputed IN (0, 1)),
    missing_input_count INTEGER NOT NULL,
    earnings_basis TEXT NOT NULL,
    valuation_date TEXT,
    forecast_source_date TEXT,
    PRIMARY KEY (company_id, calendar_year)
) WITHOUT ROWID;

CREATE INDEX calendarized_metrics_year_idx ON calendarized_metrics(calendar_year);

CREATE VIEW current_universe AS
SELECT
    c.company_id,
    c.company_name,
    c.country,
    c.segment,
    c.inclusion_tier,
    c.preferred_ticker AS ticker,
    c.fiscal_year_is_calendar,
    c.fiscal_year_end,
    CASE
        WHEN c.fiscal_year_is_calendar = 1 THEN 'Standard (Dec 31)'
        ELSE 'Non-standard (' || c.fiscal_year_end || ')'
    END AS fiscal_year,
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

CREATE VIEW valuation_matrix AS
SELECT
    c.company_id,
    c.company_name,
    c.preferred_ticker AS ticker,
    MAX(CASE WHEN m.calendar_year = 2027 THEN m.eps END) AS cy2027_eps,
    MAX(CASE WHEN m.calendar_year = 2027 THEN m.fcf_per_share END) AS cy2027_fcf_per_share,
    MAX(CASE WHEN m.calendar_year = 2027 THEN m.pe END) AS cy2027_pe,
    MAX(CASE WHEN m.calendar_year = 2027 THEN m.ev_to_fcf END) AS cy2027_ev_to_fcf,
    MAX(CASE WHEN m.calendar_year = 2027 THEN m.net_leverage END) AS cy2027_net_leverage,
    MAX(CASE WHEN m.calendar_year = 2028 THEN m.eps END) AS cy2028_eps,
    MAX(CASE WHEN m.calendar_year = 2028 THEN m.fcf_per_share END) AS cy2028_fcf_per_share,
    MAX(CASE WHEN m.calendar_year = 2028 THEN m.pe END) AS cy2028_pe,
    MAX(CASE WHEN m.calendar_year = 2028 THEN m.ev_to_fcf END) AS cy2028_ev_to_fcf,
    MAX(CASE WHEN m.calendar_year = 2028 THEN m.net_leverage END) AS cy2028_net_leverage
FROM companies AS c
LEFT JOIN calendarized_metrics AS m ON m.company_id = c.company_id
GROUP BY c.company_id, c.company_name, c.preferred_ticker;
