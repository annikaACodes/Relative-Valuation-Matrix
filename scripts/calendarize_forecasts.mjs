#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UNIVERSE_PATH = path.join(DATA, "semiconductor_universe.csv");
const FORECAST_PATH = path.join(DATA, "fiscal_forecasts.csv");
const VALUATION_PATH = path.join(DATA, "valuation_inputs.csv");
const OUTPUT_PATH = path.join(DATA, "calendarized_metrics.csv");

const METRIC_COLUMNS = [
  "CY2027 EPS",
  "CY2027 FCF/share",
  "CY2027 P/E",
  "CY2027 EV/FCF",
  "CY2027 Net leverage",
  "CY2028 EPS",
  "CY2028 FCF/share",
  "CY2028 P/E",
  "CY2028 EV/FCF",
  "CY2028 Net leverage",
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some(Boolean)) rows.push(row);
  }
  const header = rows.shift();
  return rows.map((values) => Object.fromEntries(header.map((key, i) => [key, values[i] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function scaleToMillions(value, scale) {
  if (value == null) return null;
  if (scale === "Billion") return value * 1000;
  if (scale === "Thousand") return value / 1000;
  if (scale === "Million") return value;
  return null;
}

function daysInYear(year) {
  return (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
}

function lastWeekday(year, month, weekday) {
  const date = new Date(Date.UTC(year, month, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
  return date;
}

function closestWeekday(year, month, day, weekday) {
  const target = new Date(Date.UTC(year, month - 1, day));
  const previous = new Date(target);
  previous.setUTCDate(target.getUTCDate() - ((target.getUTCDay() - weekday + 7) % 7));
  const next = new Date(previous);
  next.setUTCDate(previous.getUTCDate() + 7);
  return target - previous <= next - target ? previous : next;
}

function fiscalEndDate(rule, year) {
  if (rule === "Standard (Dec 31)") return new Date(Date.UTC(year, 11, 31));
  const description = rule.replace(/^Non-standard \(/, "").replace(/\)$/, "");
  const fixed = description.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/);
  if (fixed) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return new Date(Date.UTC(year, months.indexOf(fixed[1]), Number(fixed[2])));
  }
  const lower = description.toLowerCase();
  if (lower.includes("last sunday in january")) return lastWeekday(year, 1, 0);
  if (lower.includes("last sunday in june")) return lastWeekday(year, 6, 0);
  if (lower.includes("last sunday in october")) return lastWeekday(year, 10, 0);
  if (lower.includes("last sunday in september")) return lastWeekday(year, 9, 0);
  if (lower.includes("last saturday in december")) return lastWeekday(year, 12, 6);
  if (lower.includes("thursday closest to aug 31")) return closestWeekday(year, 8, 31, 4);
  if (lower.includes("sunday closest to oct 31")) return closestWeekday(year, 10, 31, 0);
  if (lower.includes("saturday closest to oct 31")) return closestWeekday(year, 10, 31, 6);
  if (lower.includes("saturday closest to jan 31")) return closestWeekday(year, 1, 31, 6);
  if (lower.includes("saturday closest to apr 30")) return closestWeekday(year, 4, 30, 6);
  if (lower.includes("saturday closest to dec 31")) return closestWeekday(year, 12, 31, 6);
  if (lower.includes("saturday closest to jun 30")) return closestWeekday(year, 6, 30, 6);
  if (lower.includes("friday nearest to jun 30")) return closestWeekday(year, 6, 30, 5);
  if (lower.includes("friday closest to sep 30")) return closestWeekday(year, 9, 30, 5);
  throw new Error(`Unsupported fiscal-year rule: ${rule}`);
}

function fiscalWeight(rule, year) {
  if (rule === "Standard (Dec 31)") return 1;
  const end = fiscalEndDate(rule, year);
  const start = Date.UTC(year, 0, 1);
  return (end.getTime() - start + 86400000) / 86400000 / daysInYear(year);
}

function interpolate(values, year, weight, allowFlatTail) {
  const current = values.get(year);
  if (current == null) return { value: null, tailImputed: false };
  if (weight === 1) return { value: current, tailImputed: false };
  let next = values.get(year + 1);
  let tailImputed = false;
  if (next == null && allowFlatTail && 1 - weight <= 0.34) {
    next = current;
    tailImputed = true;
  }
  if (next == null) return { value: null, tailImputed: false };
  return { value: weight * current + (1 - weight) * next, tailImputed };
}

function fixed(value, digits) {
  if (value == null || !Number.isFinite(value)) return "";
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

const universe = parseCsv(fs.readFileSync(UNIVERSE_PATH, "utf8"));
const forecasts = parseCsv(fs.readFileSync(FORECAST_PATH, "utf8"));
const valuations = parseCsv(fs.readFileSync(VALUATION_PATH, "utf8"));
const valuationByCompany = new Map(valuations.map((row) => [row.company_id, row]));
const groupByCompany = (rows) => {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.company_id)) grouped.set(row.company_id, []);
    grouped.get(row.company_id).push(row);
  }
  return grouped;
};
const forecastByCompany = groupByCompany(forecasts);
const output = [];

for (const company of universe) {
  const fiscalRows = forecastByCompany.get(company.company_id) ?? [];
  const valuation = valuationByCompany.get(company.company_id);
  const currency = fiscalRows.find((row) => row.reporting_currency)?.reporting_currency ?? "";
  const price = numberOrNull(valuation?.price);
  const fx = numberOrNull(valuation?.price_to_reporting_fx);
  const reportingPrice = price != null && fx != null ? price * fx : null;

  const series = { earnings: new Map(), ebitda: new Map(), fcf: new Map(), netDebt: new Map(), shares: new Map() };
  let usesNetIncomeFallback = false;
  for (const row of fiscalRows) {
    const year = Number(row.fiscal_year);
    const sharesThousands = numberOrNull(row.diluted_shares_thousands);
    const sharesMillions = sharesThousands == null ? null : sharesThousands / 1000;
    const sourceEps = numberOrNull(row.source_eps);
    const netIncome = scaleToMillions(numberOrNull(row.net_income), row.income_scale);
    const earnings = sourceEps != null && sharesMillions > 0 ? sourceEps * sharesMillions : netIncome;
    if (earnings != null && !(sourceEps != null && sharesMillions > 0)) usesNetIncomeFallback = true;
    series.earnings.set(year, earnings);
    series.ebitda.set(year, scaleToMillions(numberOrNull(row.ebitda), row.income_scale));
    series.fcf.set(year, scaleToMillions(numberOrNull(row.fcf), row.fcf_scale));
    series.netDebt.set(year, scaleToMillions(numberOrNull(row.net_debt), row.net_debt_scale));
    series.shares.set(year, sharesMillions);
  }

  for (const year of [2027, 2028]) {
    const weight = fiscalWeight(company["Fiscal Year"], year);
    const earnings = interpolate(series.earnings, year, weight, true);
    const ebitda = interpolate(series.ebitda, year, weight, true);
    const fcf = interpolate(series.fcf, year, weight, true);
    const netDebt = interpolate(series.netDebt, year, weight, true);
    const shares = interpolate(series.shares, year, weight, true);
    const eps = earnings.value != null && shares.value > 0 ? earnings.value / shares.value : null;
    const fcfPerShare = fcf.value != null && shares.value > 0 ? fcf.value / shares.value : null;
    const pe = reportingPrice != null && eps > 0 ? reportingPrice / eps : null;
    const equityValue = reportingPrice != null && shares.value > 0 ? reportingPrice * shares.value : null;
    const evToFcf = equityValue != null && netDebt.value != null && fcf.value > 0
      ? (equityValue + netDebt.value) / fcf.value
      : null;
    const netLeverage = netDebt.value != null && ebitda.value > 0 ? netDebt.value / ebitda.value : null;
    const required = [earnings, ebitda, fcf, netDebt, shares];
    const missing = required.filter((item) => item.value == null).length;
    const tailImputed = required.some((item) => item.tailImputed);
    const quality = missing ? "partial" : tailImputed ? "flat-tail" : "direct";
    output.push({
      company_id: company.company_id,
      calendar_year: String(year),
      reporting_currency: currency,
      fiscal_year_weight: fixed(weight, 6),
      next_fiscal_year_weight: fixed(1 - weight, 6),
      eps: fixed(eps, 4),
      fcf_per_share: fixed(fcfPerShare, 4),
      pe: fixed(pe, 2),
      ev_to_fcf: fixed(evToFcf, 2),
      net_leverage: fixed(netLeverage, 2),
      calculation_quality: quality,
      tail_imputed: tailImputed ? "1" : "0",
      missing_input_count: String(missing),
      earnings_basis: usesNetIncomeFallback ? "mixed-or-net-income" : "published-consensus-eps",
      valuation_date: valuation?.valuation_date ?? "",
      forecast_source_date: fiscalRows[0]?.source_retrieved_at ?? "",
    });
  }
}

writeCsv(OUTPUT_PATH, output, [
  "company_id", "calendar_year", "reporting_currency", "fiscal_year_weight",
  "next_fiscal_year_weight", "eps", "fcf_per_share", "pe", "ev_to_fcf",
  "net_leverage", "calculation_quality", "tail_imputed", "missing_input_count",
  "earnings_basis", "valuation_date", "forecast_source_date",
]);

const metricsByCompany = groupByCompany(output);
const universeColumns = Object.keys(universe[0]).filter((key) => !METRIC_COLUMNS.includes(key));
for (const company of universe) {
  for (const year of [2027, 2028]) {
    const metric = (metricsByCompany.get(company.company_id) ?? []).find((row) => row.calendar_year === String(year));
    company[`CY${year} EPS`] = metric?.eps ?? "";
    company[`CY${year} FCF/share`] = metric?.fcf_per_share ?? "";
    company[`CY${year} P/E`] = metric?.pe ?? "";
    company[`CY${year} EV/FCF`] = metric?.ev_to_fcf ?? "";
    company[`CY${year} Net leverage`] = metric?.net_leverage ?? "";
  }
}
writeCsv(UNIVERSE_PATH, universe, [...universeColumns, ...METRIC_COLUMNS]);

const complete2027 = output.filter((row) => row.calendar_year === "2027" && row.missing_input_count === "0").length;
const complete2028 = output.filter((row) => row.calendar_year === "2028" && row.missing_input_count === "0").length;
const flatTail = output.filter((row) => row.tail_imputed === "1").length;
console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`Complete rows: CY2027 ${complete2027}/${universe.length}; CY2028 ${complete2028}/${universe.length}; flat-tail rows ${flatTail}`);
