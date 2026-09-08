"use strict";

const DATA_PATHS = {
  universe: "data/semiconductor_universe.csv",
  calendarized: "data/calendarized_metrics.csv",
};

const MAX_SELECTION = 10;
const INSUFFICIENT_DATA = "Insufficient Data";
const COMPARE_EMPTY = "&mdash;";
const DEFAULT_SELECTION = ["nvidia", "tsmc", "broadcom"];
const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXCELJS_SOURCES = [
  "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
  "https://unpkg.com/exceljs@4.4.0/dist/exceljs.min.js",
];
const EXCEL_COLORS = {
  navy: "FF17324D",
  blue2027: "FF315E7D",
  blue2028: "FF347DB5",
  blueSoft: "FFEAF2F8",
  body: "FF203446",
  muted: "FF66798B",
  border: "FFDCE5ED",
  band: "FFF7F9FB",
  missingFill: "FFF1F4F6",
  missingText: "FF718096",
  orange: "FFC96B2C",
  orangeSoft: "FFFBE7D5",
  white: "FFFFFFFF",
};
const COMPARE_METRICS = [
  { key: "eps", label: "EPS", chart: "growth", unit: "reported currency / share" },
  { key: "fcf", label: "FCF / share", chart: "growth", unit: "reported currency / share" },
  { key: "pe", label: "P / E", chart: "bars", unit: "multiple" },
  { key: "ev_fcf", label: "EV / FCF", chart: "bars", unit: "multiple" },
  { key: "leverage", label: "Net leverage", chart: "leverage", unit: "net debt / EBITDA" },
];
const MATRIX_METRICS = [
  { key: "eps", usdKey: "eps_usd", label: "EPS", perShare: true },
  { key: "fcf", usdKey: "fcf_usd", label: "FCF / share", perShare: true },
  { key: "pe", label: "P / E", unit: "multiple" },
  { key: "ev_fcf", label: "EV / FCF", unit: "multiple" },
  { key: "leverage", label: "Net leverage", unit: "net debt / EBITDA" },
];
const MATRIX_METRIC_KEYS = MATRIX_METRICS.map((metric) => metric.key);

const state = {
  companies: [],
  selectedIds: [],
  activeView: "matrix",
  query: "",
  category: "all",
  perShareUnit: "usd",
  yearView: "both",
  visibleMetrics: [...MATRIX_METRIC_KEYS],
  sortKey: "market_cap_usd_bn",
  sortDirection: "desc",
  optionIndex: -1,
  toastTimer: null,
};

const elements = {};
let excelJsPromise = null;

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindEvents();
  initialize();
});

function cacheElements() {
  const ids = [
    "headerAsOf",
    "companyCount",
    "marketCapAsOf",
    "matrixSearch",
    "categoryFilter",
    "yearToggle",
    "currencyToggle",
    "metricSelector",
    "metricSelectionCount",
    "matrixResultCount",
    "matrixTable",
    "matrixColgroup",
    "matrixHead",
    "matrixBody",
    "matrixLoading",
    "companySearch",
    "companyOptions",
    "selectedCompanies",
    "selectionLimit",
    "navCompareCount",
    "peerStats",
    "comparisonCharts",
    "changeTableBody",
    "copyLinkButton",
    "exportCompareButton",
    "exportMatrixButton",
    "errorState",
    "retryButton",
    "toast",
  ];
  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  elements.matrixSearch.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderMatrix();
  });

  elements.categoryFilter.addEventListener("change", (event) => {
    state.category = event.target.value;
    renderMatrix();
  });

  elements.currencyToggle.addEventListener("click", (event) => {
    const button = event.target.closest("[data-per-share-unit]");
    if (button) setPerShareUnit(button.dataset.perShareUnit);
  });

  elements.yearToggle.addEventListener("click", (event) => {
    const button = event.target.closest("[data-year-view]");
    if (button) setYearView(button.dataset.yearView);
  });

  elements.metricSelector.addEventListener("change", (event) => {
    const input = event.target.closest("[data-metric-toggle]");
    if (input) setMetricVisibility(input.dataset.metricToggle, input.checked);
  });

  elements.matrixHead.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (button) setSort(button.dataset.sort);
  });

  elements.matrixBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-company-add]");
    if (!button) return;
    toggleCompany(button.dataset.companyAdd);
  });

  elements.companySearch.addEventListener("focus", () => renderCompanyOptions());
  elements.companySearch.addEventListener("input", () => {
    state.optionIndex = -1;
    renderCompanyOptions();
  });
  elements.companySearch.addEventListener("keydown", handleCompanySearchKeydown);

  elements.companyOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-option-id]");
    if (option) addCompany(option.dataset.optionId);
  });

  elements.selectedCompanies.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (button) removeCompany(button.dataset.removeId);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".company-combobox")) closeCompanyOptions();
  });

  elements.copyLinkButton.addEventListener("click", copyComparisonLink);
  elements.exportCompareButton.addEventListener("click", () => exportComparisonWorkbook(getSelectedCompanies()));
  elements.exportMatrixButton.addEventListener("click", () => exportMatrixView(getFilteredCompanies()));
  elements.retryButton.addEventListener("click", initialize);

  window.addEventListener("hashchange", () => {
    const view = window.location.hash.replace("#", "");
    if (view === "matrix" || view === "compare") setView(view, false);
  });
}

async function initialize() {
  elements.errorState.hidden = true;
  elements.matrixLoading.hidden = false;
  try {
    const [universeText, calendarizedText] = await Promise.all([
      fetchText(DATA_PATHS.universe),
      fetchText(DATA_PATHS.calendarized),
    ]);
    const universeRows = parseCsv(universeText);
    const calendarizedRows = parseCsv(calendarizedText);
    const calendarizedMap = new Map(
      calendarizedRows.map((row) => [`${row.company_id}:${row.calendar_year}`, row]),
    );

    state.companies = universeRows.map((row) => normalizeCompany(row, calendarizedMap));
    hydrateMatrixPreferences();
    hydrateSelectionFromUrl();
    populateCategories();
    renderSummary();
    renderMatrix();
    renderComparison();

    const requestedView = window.location.hash.replace("#", "");
    setView(requestedView === "compare" ? "compare" : "matrix", false);
    elements.matrixLoading.hidden = true;
  } catch (error) {
    console.error(error);
    elements.matrixLoading.hidden = true;
    elements.errorState.hidden = false;
    document.querySelectorAll("[data-view-panel]").forEach((panel) => {
      panel.hidden = true;
    });
  }
}

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${path}: ${response.status}`);
  return response.text();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const [headers, ...values] = rows;
  return values.map((valuesRow) => Object.fromEntries(headers.map((header, index) => [header, valuesRow[index] ?? ""])));
}

function normalizeCompany(row, calendarizedMap) {
  const year2027 = calendarizedMap.get(`${row.company_id}:2027`) || {};
  const year2028 = calendarizedMap.get(`${row.company_id}:2028`) || {};
  return {
    id: row.company_id,
    company_name: row.company_name,
    Ticker: row.Ticker,
    fiscal_year: row["Fiscal Year"],
    country: row.country,
    segment: row.segment,
    category: getCategory(row.segment),
    inclusion_tier: row.inclusion_tier,
    universe_status: row.universe_status,
    market_cap_usd_bn: numeric(row.market_cap_usd_bn),
    market_cap_as_of: row.market_cap_as_of,
    reporting_currency: year2027.reporting_currency || year2028.reporting_currency || row.primary_currency,
    forecast_source_date: [year2027.forecast_source_date, year2028.forecast_source_date].filter(Boolean).sort().at(-1) || "",
    cy2027_eps: numeric(row["CY2027 EPS"]),
    cy2027_eps_usd: numeric(row["CY2027 EPS (USD)"]),
    cy2027_fcf: numeric(row["CY2027 FCF/share"]),
    cy2027_fcf_usd: numeric(row["CY2027 FCF/share (USD)"]),
    cy2027_pe: numeric(row["CY2027 P/E"]),
    cy2027_ev_fcf: numeric(row["CY2027 EV/FCF"]),
    cy2027_leverage: numeric(row["CY2027 Net leverage"]),
    cy2028_eps: numeric(row["CY2028 EPS"]),
    cy2028_eps_usd: numeric(row["CY2028 EPS (USD)"]),
    cy2028_fcf: numeric(row["CY2028 FCF/share"]),
    cy2028_fcf_usd: numeric(row["CY2028 FCF/share (USD)"]),
    cy2028_pe: numeric(row["CY2028 P/E"]),
    cy2028_ev_fcf: numeric(row["CY2028 EV/FCF"]),
    cy2028_leverage: numeric(row["CY2028 Net leverage"]),
    quality2027: year2027.calculation_quality || "unknown",
    quality2028: year2028.calculation_quality || "unknown",
  };
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCategory(segment = "") {
  const value = segment.toLowerCase();
  if (value.includes("foundry")) return "Foundry";
  if (value.includes("memory") || value.includes("storage")) return "Memory & storage";
  if (value.includes("eda") || value.includes("design software")) return "EDA & design software";
  if (value.includes("fabless") || value.includes("semiconductor ip")) return "Fabless & IP";
  if (value.includes("idm")) return "IDM";
  if (value.includes("equipment") || value.includes("processing") || value.includes("process control") || value.includes("vacuum")) return "Equipment";
  if (value.includes("packag") || value.includes("test") || value.includes("substrate") || value.includes("interconnect")) return "Packaging & test";
  if (value.includes("material") || value.includes("wafer") || value.includes("photomask") || value.includes("component")) return "Materials & components";
  if (value.includes("photon") || value.includes("opto") || value.includes("laser") || value.includes("image sensor")) return "Photonics & sensors";
  return "Diversified & other";
}

function populateCategories() {
  const categories = [...new Set(state.companies.map((company) => company.category))].sort();
  elements.categoryFilter.innerHTML = [
    '<option value="all">All businesses</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");
}

function renderSummary() {
  const dates = state.companies.map((company) => company.market_cap_as_of).filter(Boolean).sort();
  const asOf = dates.at(-1);

  elements.companyCount.textContent = String(state.companies.length);
  elements.marketCapAsOf.textContent = formatDate(asOf);
  elements.headerAsOf.textContent = `Estimates as of ${formatDate(getLatestForecastDate())}`;
}

function getLatestForecastDate() {
  return state.companies.map((company) => company.forecast_source_date).filter(Boolean).sort().at(-1) || "";
}

function renderMatrix() {
  if (!state.companies.length) return;
  syncMatrixControls();
  const years = getVisibleYears();
  const metrics = getVisibleMatrixMetrics();
  renderMatrixStructure(years, metrics);
  const companies = getFilteredCompanies();
  const selected = new Set(state.selectedIds);
  const columnCount = 4 + (years.length * metrics.length);

  elements.matrixResultCount.textContent = `${companies.length} ${companies.length === 1 ? "company" : "companies"}`;
  elements.matrixBody.innerHTML = companies.length
    ? companies.map((company) => matrixRow(company, selected.has(company.id), years, metrics)).join("")
    : `<tr class="empty-row"><td colspan="${columnCount}">No companies match the current filters.</td></tr>`;

  syncSortControls();
}

function renderMatrixStructure(years, metrics) {
  const metricColumnCount = years.length * metrics.length;
  const actionArea = 3.5;
  const widths = {
    company: 17.216,
    marketCap: 8,
    business: 9.684,
    metric: 61.6 / metricColumnCount,
  };
  const metricType = widths.metric >= 20
    ? { cell: "0.96rem", header: "0.88rem", year: "0.92rem" }
    : widths.metric >= 12
      ? { cell: "0.9rem", header: "0.84rem", year: "0.88rem" }
      : widths.metric >= 8
        ? { cell: "0.84rem", header: "0.79rem", year: "0.85rem" }
        : { cell: "0.77rem", header: "0.74rem", year: "0.8rem" };
  elements.matrixTable.style.setProperty("--metric-cell-font-size", metricType.cell);
  elements.matrixTable.style.setProperty("--metric-header-font-size", metricType.header);
  elements.matrixTable.style.setProperty("--year-group-font-size", metricType.year);
  const metricColumns = years.flatMap((year) => metrics.map((metric) => (
    `<col class="metric-col" data-year="${year}" data-metric="${escapeHtml(metric.baseKey)}" style="width:${widths.metric.toFixed(3)}%" />`
  ))).join("");
  elements.matrixColgroup.innerHTML = `
    <col class="company-col" style="width:${widths.company.toFixed(3)}%" />
    <col class="market-cap-col" style="width:${widths.marketCap.toFixed(3)}%" />
    <col class="business-col" style="width:${widths.business.toFixed(3)}%" />
    ${metricColumns}
    <col class="action-col" style="width:${actionArea}%" />`;

  const yearGroups = years.map((year) => (
    `<th class="year-group year-${year}" colspan="${metrics.length}" scope="colgroup">CY${year}</th>`
  )).join("");
  const metricHeaders = years.flatMap((year) => metrics.map((metric) => {
    const tableLabel = metricTableLabel(metric.baseKey);
    const unit = metric.perShare ? `<small>${state.perShareUnit === "usd" ? "USD" : "local"}</small>` : "";
    const sortLabel = `CY${year} ${metric.label}`;
    return `<th scope="col"><button class="sort-button" type="button" data-sort="cy${year}_${metric.key}" data-sort-label="${escapeHtml(sortLabel)}">${escapeHtml(tableLabel)}${unit}</button></th>`;
  })).join("");

  elements.matrixHead.innerHTML = `
    <tr class="year-groups">
      <th class="sticky-company company-column" rowspan="2" scope="col"><button class="sort-button" type="button" data-sort="company_name" data-sort-label="Company">Company</button></th>
      <th class="market-cap-column" rowspan="2" scope="col"><button class="sort-button" type="button" data-sort="market_cap_usd_bn" data-sort-label="Market cap">Market cap</button></th>
      <th class="segment-column" rowspan="2" scope="col"><button class="sort-button" type="button" data-sort="segment" data-sort-label="Business">Business</button></th>
      ${yearGroups}
      <th class="compare-column" rowspan="2" scope="col"><span class="sr-only">Add to comparison</span></th>
    </tr>
    <tr class="metric-headers">${metricHeaders}</tr>`;
}

function syncSortControls() {
  elements.matrixHead.querySelectorAll("[data-sort]").forEach((button) => {
    const active = button.dataset.sort === state.sortKey;
    const label = button.dataset.sortLabel || button.textContent.trim();
    const header = button.closest("th");
    if (active) {
      const textSort = state.sortKey === "company_name" || state.sortKey === "Ticker" || state.sortKey === "segment";
      const directionLabel = textSort
        ? state.sortDirection === "asc" ? "A to Z" : "Z to A"
        : state.sortDirection === "asc" ? "least to greatest" : "greatest to least";
      button.dataset.direction = state.sortDirection;
      button.setAttribute("aria-label", `${label}, sorted ${directionLabel}. Activate to reverse.`);
      header?.setAttribute("aria-sort", state.sortDirection === "asc" ? "ascending" : "descending");
    } else {
      button.removeAttribute("data-direction");
      button.setAttribute("aria-label", `Sort by ${label}`);
      header?.setAttribute("aria-sort", "none");
    }
  });
}

function hydrateMatrixPreferences() {
  try {
    const savedUnit = window.localStorage.getItem("rvm-per-share-unit");
    const savedYear = window.localStorage.getItem("rvm-year-view");
    const savedMetrics = JSON.parse(window.localStorage.getItem("rvm-visible-metrics") || "null");
    if (savedUnit === "usd" || savedUnit === "local") state.perShareUnit = savedUnit;
    if (savedYear === "2027" || savedYear === "2028" || savedYear === "both") state.yearView = savedYear;
    if (Array.isArray(savedMetrics)) {
      const validMetrics = MATRIX_METRIC_KEYS.filter((key) => savedMetrics.includes(key));
      if (validMetrics.length) state.visibleMetrics = validMetrics;
    }
  } catch {
    state.perShareUnit = "usd";
    state.yearView = "both";
    state.visibleMetrics = [...MATRIX_METRIC_KEYS];
  }
}

function setPerShareUnit(unit) {
  if ((unit !== "usd" && unit !== "local") || state.perShareUnit === unit) return;
  state.perShareUnit = unit;
  const perShareSort = state.sortKey.match(/^cy(2027|2028)_(eps|fcf)(?:_usd)?$/);
  if (perShareSort) {
    const [, year, metric] = perShareSort;
    state.sortKey = `cy${year}_${metric}${unit === "usd" ? "_usd" : ""}`;
  }
  persistMatrixPreferences();
  renderMatrix();
}

function setYearView(yearView) {
  if ((yearView !== "2027" && yearView !== "2028" && yearView !== "both") || state.yearView === yearView) return;
  state.yearView = yearView;
  resetHiddenSort();
  persistMatrixPreferences();
  renderMatrix();
}

function setMetricVisibility(metricKey, visible) {
  if (!MATRIX_METRIC_KEYS.includes(metricKey)) return;
  const selected = new Set(state.visibleMetrics);
  if (visible) selected.add(metricKey);
  else if (selected.size > 1) selected.delete(metricKey);
  state.visibleMetrics = MATRIX_METRIC_KEYS.filter((key) => selected.has(key));
  resetHiddenSort();
  persistMatrixPreferences();
  renderMatrix();
}

function persistMatrixPreferences() {
  try {
    window.localStorage.setItem("rvm-per-share-unit", state.perShareUnit);
    window.localStorage.setItem("rvm-year-view", state.yearView);
    window.localStorage.setItem("rvm-visible-metrics", JSON.stringify(state.visibleMetrics));
  } catch {
    // Matrix controls remain usable when storage is unavailable.
  }
}

function resetHiddenSort() {
  const metricSort = state.sortKey.match(/^cy(2027|2028)_(eps|fcf|pe|ev_fcf|leverage)(?:_usd)?$/);
  if (!metricSort) return;
  const [, year, metric] = metricSort;
  if (!getVisibleYears().includes(Number(year)) || !state.visibleMetrics.includes(metric)) {
    state.sortKey = "market_cap_usd_bn";
    state.sortDirection = "desc";
  }
}

function syncMatrixControls() {
  document.querySelectorAll("[data-year-view]").forEach((button) => {
    const active = button.dataset.yearView === state.yearView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const oneMetricSelected = state.visibleMetrics.length === 1;
  document.querySelectorAll("[data-metric-toggle]").forEach((input) => {
    const checked = state.visibleMetrics.includes(input.dataset.metricToggle);
    input.checked = checked;
    input.disabled = checked && oneMetricSelected;
    input.closest(".metric-choice")?.classList.toggle("is-required", input.disabled);
    input.closest(".metric-choice")?.setAttribute("title", input.disabled ? "At least one metric must remain selected" : "");
  });
  elements.metricSelectionCount.textContent = `${state.visibleMetrics.length} selected`;

  const perShareVisible = state.visibleMetrics.includes("eps") || state.visibleMetrics.includes("fcf");
  elements.currencyToggle.closest(".unit-toggle-field")?.classList.toggle("is-disabled", !perShareVisible);
  document.querySelectorAll("[data-per-share-unit]").forEach((button) => {
    const active = button.dataset.perShareUnit === state.perShareUnit;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = !perShareVisible;
    button.title = perShareVisible ? "" : "Available when EPS or FCF/share is selected";
  });
}

function getVisibleYears() {
  if (state.yearView === "2027") return [2027];
  if (state.yearView === "2028") return [2028];
  return [2027, 2028];
}

function getVisibleMatrixMetrics() {
  return MATRIX_METRICS
    .filter((metric) => state.visibleMetrics.includes(metric.key))
    .map((metric) => ({
      ...metric,
      baseKey: metric.key,
      key: metric.perShare && state.perShareUnit === "usd" ? metric.usdKey : metric.key,
    }));
}

function metricTableLabel(metricKey) {
  return {
    eps: "EPS",
    fcf: "FCF/share",
    pe: "P/E",
    ev_fcf: "EV/FCF",
    leverage: "Net lev.",
  }[metricKey];
}

function getFilteredCompanies() {
  return state.companies
    .filter((company) => {
      const searchText = `${company.company_name} ${company.Ticker} ${company.country} ${company.segment}`.toLowerCase();
      const matchesQuery = !state.query || searchText.includes(state.query);
      const matchesCategory = state.category === "all" || company.category === state.category;
      return matchesQuery && matchesCategory;
    })
    .sort(compareCompanies);
}

function compareCompanies(left, right) {
  const leftValue = left[state.sortKey];
  const rightValue = right[state.sortKey];
  const direction = state.sortDirection === "asc" ? 1 : -1;
  if (leftValue === null && rightValue === null) return left.company_name.localeCompare(right.company_name);
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  if (typeof leftValue === "number" && typeof rightValue === "number") return (leftValue - rightValue) * direction;
  return String(leftValue).localeCompare(String(rightValue)) * direction;
}

function setSort(key) {
  if (state.sortKey === key) state.sortDirection = state.sortDirection === "asc" ? "desc" : "asc";
  else {
    state.sortKey = key;
    state.sortDirection = key === "company_name" || key === "Ticker" || key === "segment" ? "asc" : "desc";
  }
  renderMatrix();
}

function matrixRow(company, isSelected, years, metrics) {
  const metricCells = years.flatMap((year) => metrics.map((metric) => metricCell(company, year, metric))).join("");
  const atLimit = state.selectedIds.length >= MAX_SELECTION && !isSelected;
  const actionLabel = isSelected ? `Remove ${company.company_name} from comparison` : `Add ${company.company_name} to comparison`;
  return `
    <tr class="${isSelected ? "is-selected" : ""}">
      <td class="sticky-company">
        <div class="company-cell" title="${escapeHtml(company.company_name)}">
          <span class="company-ticker">${escapeHtml(company.Ticker)}</span>
          <span class="company-name-wrap">
            <span class="company-name">${escapeHtml(company.company_name)}</span>
            <span class="company-country">${escapeHtml(company.country)}</span>
          </span>
        </div>
      </td>
      <td>${formatMarketCap(company.market_cap_usd_bn)}</td>
      <td><span class="segment-text" title="${escapeHtml(company.segment)}">${escapeHtml(company.segment)}</span></td>
      ${metricCells}
      <td>
        <button
          class="row-compare-button ${isSelected ? "is-selected" : ""}"
          type="button"
          data-company-add="${escapeHtml(company.id)}"
          title="${escapeHtml(actionLabel)}"
          aria-label="${escapeHtml(actionLabel)}"
          ${atLimit ? "disabled" : ""}
        >${isSelected ? "&#10003;" : "+"}</button>
      </td>
    </tr>`;
}

function metricCell(company, year, metric) {
  const value = company[`cy${year}_${metric.key}`];
  const quality = company[`quality${year}`];
  const titleParts = [`${metric.label}: ${value === null ? INSUFFICIENT_DATA : formatFull(value, metric.key)}`];
  const isUsdPerShare = metric.key === "eps_usd" || metric.key === "fcf_usd";
  const isLocalPerShare = metric.key === "eps" || metric.key === "fcf";
  if (isUsdPerShare) titleParts.push("USD per underlying ordinary share");
  if (isLocalPerShare) titleParts.push(`${company.reporting_currency} per underlying ordinary share`);
  titleParts.push(`Quality: ${quality}`);
  const marker = quality === "flat-tail" ? '<i class="quality-marker" aria-label="Flat-tail estimate"></i>' : "";
  const perShareUnit = isUsdPerShare ? "USD" : isLocalPerShare ? company.reporting_currency : "";
  const unit = value !== null && perShareUnit ? `<small class="cell-unit">${escapeHtml(perShareUnit)}</small>` : "";
  return `<td data-year="${year}" data-metric="${escapeHtml(metric.baseKey)}" title="${escapeHtml(titleParts.join(" | "))}">${value === null ? `<span class="metric-missing">${INSUFFICIENT_DATA}</span>` : `<span class="metric-value">${formatMetric(value, metric.key)}${marker}</span>${unit}`}</td>`;
}

function setView(view, updateHash = true) {
  state.activeView = view;
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (updateHash && window.location.hash !== `#${view}`) history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${view}`);
  if (view === "compare") renderComparison();
}

function hydrateSelectionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const requested = (params.get("companies") || "").split(",").filter(Boolean);
  const valid = requested.filter((id) => state.companies.some((company) => company.id === id)).slice(0, MAX_SELECTION);
  state.selectedIds = valid.length ? valid : DEFAULT_SELECTION.filter((id) => state.companies.some((company) => company.id === id));
}

function toggleCompany(id) {
  if (state.selectedIds.includes(id)) removeCompany(id);
  else addCompany(id, false);
}

function addCompany(id, switchView = true) {
  if (state.selectedIds.includes(id)) return;
  if (state.selectedIds.length >= MAX_SELECTION) {
    showToast("The comparison is limited to 10 companies.");
    return;
  }
  state.selectedIds.push(id);
  elements.companySearch.value = "";
  closeCompanyOptions();
  updateSelectionUrl();
  renderMatrix();
  renderComparison();
  if (switchView && state.activeView !== "compare") setView("compare");
}

function removeCompany(id) {
  state.selectedIds = state.selectedIds.filter((companyId) => companyId !== id);
  updateSelectionUrl();
  renderMatrix();
  renderComparison();
}

function getSelectedCompanies() {
  return state.selectedIds.map((id) => state.companies.find((company) => company.id === id)).filter(Boolean);
}

function renderComparison() {
  if (!state.companies.length) return;
  const companies = getSelectedCompanies();
  elements.navCompareCount.textContent = String(companies.length);
  elements.selectionLimit.textContent = `${companies.length} / ${MAX_SELECTION}`;
  elements.companySearch.disabled = companies.length >= MAX_SELECTION;
  elements.companySearch.placeholder = companies.length >= MAX_SELECTION ? "Selection limit reached" : "Search by company or ticker";
  renderSelectedChips(companies);
  renderPeerStats(companies);
  renderCharts(companies);
  renderChangeTable(companies);
}

function renderSelectedChips(companies) {
  elements.selectedCompanies.innerHTML = companies.length
    ? companies
        .map(
          (company) => `
          <span class="company-chip">
            <span class="chip-label">${escapeHtml(company.company_name)}</span>
            <span class="chip-ticker">${escapeHtml(company.Ticker)}</span>
            <button class="remove-chip-button" type="button" data-remove-id="${escapeHtml(company.id)}" title="Remove ${escapeHtml(company.company_name)}" aria-label="Remove ${escapeHtml(company.company_name)}">&times;</button>
          </span>`,
        )
        .join("")
    : '<span class="option-empty">No companies selected</span>';
}

function renderCompanyOptions() {
  const search = elements.companySearch.value.trim().toLowerCase();
  const selected = new Set(state.selectedIds);
  const options = state.companies
    .filter((company) => !selected.has(company.id))
    .filter((company) => !search || `${company.company_name} ${company.Ticker} ${company.country}`.toLowerCase().includes(search))
    .sort((left, right) => right.market_cap_usd_bn - left.market_cap_usd_bn)
    .slice(0, 12);

  elements.companyOptions.innerHTML = options.length
    ? options
        .map(
          (company, index) => `
          <button class="company-option ${index === state.optionIndex ? "is-active" : ""}" type="button" role="option" aria-selected="${index === state.optionIndex}" data-option-id="${escapeHtml(company.id)}">
            <span>
              <span class="option-name">${escapeHtml(company.company_name)}</span>
              <span class="option-meta">${escapeHtml(company.country)} · ${escapeHtml(company.category)}</span>
            </span>
            <span class="option-ticker">${escapeHtml(company.Ticker)}</span>
          </button>`,
        )
        .join("")
    : '<div class="option-empty">No matching companies</div>';
  elements.companyOptions.hidden = false;
  elements.companySearch.setAttribute("aria-expanded", "true");
}

function closeCompanyOptions() {
  elements.companyOptions.hidden = true;
  elements.companySearch.setAttribute("aria-expanded", "false");
  state.optionIndex = -1;
}

function handleCompanySearchKeydown(event) {
  const options = [...elements.companyOptions.querySelectorAll("[data-option-id]")];
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.optionIndex = Math.min(state.optionIndex + 1, options.length - 1);
    renderCompanyOptions();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    state.optionIndex = Math.max(state.optionIndex - 1, 0);
    renderCompanyOptions();
  } else if (event.key === "Enter" && state.optionIndex >= 0 && options[state.optionIndex]) {
    event.preventDefault();
    addCompany(options[state.optionIndex].dataset.optionId);
  } else if (event.key === "Escape") {
    closeCompanyOptions();
  }
}

function renderPeerStats(companies) {
  const hasSelection = companies.length > 0;
  const stats = [
    ["Selected companies", String(companies.length), "of 10", false],
    ["Median CY2027 P/E", hasSelection ? multiple(median(companies.map((company) => company.cy2027_pe))) : COMPARE_EMPTY, "peer set", true],
    ["Median CY2028 P/E", hasSelection ? multiple(median(companies.map((company) => company.cy2028_pe))) : COMPARE_EMPTY, "peer set", true],
    ["Median CY2027 EV/FCF", hasSelection ? multiple(median(companies.map((company) => company.cy2027_ev_fcf))) : COMPARE_EMPTY, "peer set", true],
    ["Median CY2028 EV/FCF", hasSelection ? multiple(median(companies.map((company) => company.cy2028_ev_fcf))) : COMPARE_EMPTY, "peer set", true],
  ];
  elements.peerStats.innerHTML = stats
    .map(([label, value, note, isMedian]) => `<div class="peer-stat ${isMedian ? "is-median" : ""}"><span>${label}</span><strong>${value}<small>${note}</small></strong></div>`)
    .join("");
}

function renderCharts(companies) {
  elements.comparisonCharts.innerHTML = COMPARE_METRICS.map((metric) => metricPanel(metric, companies)).join("");
}

function metricPanel(metric, companies) {
  const title = metric.chart === "growth" ? `${metric.label} growth` : metric.label;
  const context = metric.chart === "growth" ? "CY2027 to CY2028 · reported currency" : metric.unit;
  const available = companies.filter((company) => company[`cy2027_${metric.key}`] !== null || company[`cy2028_${metric.key}`] !== null).length;
  const summaryValue = !companies.length
    ? COMPARE_EMPTY
    : metric.chart === "growth"
      ? percent(median(companies.map((company) => growth(company[`cy2027_${metric.key}`], company[`cy2028_${metric.key}`]))))
      : multiple(median(companies.map((company) => company[`cy2028_${metric.key}`])));

  return `
    <section class="metric-panel" aria-labelledby="chart-${metric.key}">
      <header class="metric-panel-header">
        <div>
          <h2 id="chart-${metric.key}">${escapeHtml(title)}</h2>
          <p>${escapeHtml(context)}</p>
        </div>
        <span class="metric-panel-summary">${available} of ${companies.length}<small>Peer median</small><strong>${summaryValue}</strong></span>
      </header>
      ${renderMetricChart(metric, companies)}
    </section>`;
}

function renderMetricChart(metric, companies) {
  if (!companies.length) return '<div class="no-chart-data">Select companies to populate the comparison.</div>';
  if (metric.chart === "bars") return renderPairedBars(metric, companies);
  if (metric.chart === "growth") return renderGrowthBars(metric, companies);
  return renderLeverageChart(metric, companies);
}

function renderPairedBars(metric, companies) {
  const allValues = companies.flatMap((company) => [company[`cy2027_${metric.key}`], company[`cy2028_${metric.key}`]]).filter(Number.isFinite);
  const maxValue = Math.max(...allValues, 1);
  const medians = {
    2027: median(companies.map((company) => company[`cy2027_${metric.key}`])),
    2028: median(companies.map((company) => company[`cy2028_${metric.key}`])),
  };
  const rows = companies.map((company) => {
    const value2027 = company[`cy2027_${metric.key}`];
    const value2028 = company[`cy2028_${metric.key}`];
    return `
      <div class="chart-company-row">
        ${chartCompanyLabel(company)}
        <div class="paired-bars">
          ${barLine(2027, value2027, maxValue, medians[2027])}
          ${barLine(2028, value2028, maxValue, medians[2028])}
        </div>
      </div>`;
  });
  return `<div class="metric-chart">${rows.join("")}</div>`;
}

function barLine(year, value, maxValue, medianValue) {
  const width = value === null ? 0 : Math.max(0, Math.min(100, (value / maxValue) * 100));
  const medianPosition = medianValue === null ? null : Math.max(0, Math.min(100, (medianValue / maxValue) * 100));
  return `
    <div class="bar-line" aria-label="CY${year}: ${value === null ? INSUFFICIENT_DATA : `${formatMetric(value, "multiple")} times`}">
      <span class="bar-year">${String(year).slice(-2)}</span>
      <span class="bar-track">
        ${medianPosition === null ? "" : `<i class="median-line" style="left:${medianPosition}%"></i>`}
        ${value === null ? "" : `<i class="bar-fill cy${String(year).slice(-2)}" style="display:block;width:${width}%"></i>`}
      </span>
      <span class="bar-value">${value === null ? INSUFFICIENT_DATA : multiple(value)}</span>
    </div>`;
}

function renderGrowthBars(metric, companies) {
  const growthValues = companies.map((company) => growth(company[`cy2027_${metric.key}`], company[`cy2028_${metric.key}`])).filter(Number.isFinite);
  const scale = Math.max(...growthValues.map((value) => Math.min(Math.abs(value), 200)), 10);
  const rows = companies.map((company) => {
    const value2027 = company[`cy2027_${metric.key}`];
    const value2028 = company[`cy2028_${metric.key}`];
    const change = growth(value2027, value2028);
    const valid = Number.isFinite(change);
    const width = valid ? Math.min(50, (Math.min(Math.abs(change), 200) / scale) * 50) : 0;
    const hasInputs = Number.isFinite(value2027) && Number.isFinite(value2028);
    const direction = !valid ? "neutral" : change > 0 ? "positive" : change < 0 ? "negative" : "neutral";
    const actuals = `${formatMetric(value2027, metric.key)} → ${formatMetric(value2028, metric.key)} ${company.reporting_currency}`;
    return `
      <div class="chart-company-row">
        ${chartCompanyLabel(company)}
        <div>
          <div class="growth-visual">
            <span class="growth-track" title="${valid && Math.abs(change) > 200 ? "Visual capped at 200%; label shows full change" : ""}">
              ${valid ? `<i class="growth-bar ${direction}" style="width:${width}%"></i>` : ""}
            </span>
            <span class="growth-value ${direction}">${valid ? signedPercent(change) : hasInputs ? "N/M" : INSUFFICIENT_DATA}</span>
          </div>
          <div class="reported-values">${escapeHtml(actuals)}</div>
        </div>
      </div>`;
  });
  return `<div class="metric-chart">${rows.join("")}</div>`;
}

function renderLeverageChart(metric, companies) {
  const values = companies.flatMap((company) => [company.cy2027_leverage, company.cy2028_leverage]).filter(Number.isFinite);
  let domainMin = -1;
  let domainMax = 1;
  if (values.length) {
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const span = Math.max(rawMax - rawMin, 0.5);
    const padding = Math.max(span * 0.15, 0.08);
    domainMin = rawMin - padding;
    domainMax = rawMax + padding;
  }
  const zeroPosition = domainMin <= 0 && domainMax >= 0 ? leveragePosition(0, domainMin, domainMax) : null;
  const rows = companies.map((company) => {
    const value2027 = company.cy2027_leverage;
    const value2028 = company.cy2028_leverage;
    const position2027 = leveragePosition(value2027, domainMin, domainMax);
    const position2028 = leveragePosition(value2028, domainMin, domainMax);
    const rangeLeft = Math.min(position2027 ?? 50, position2028 ?? 50);
    const rangeWidth = Math.abs((position2028 ?? 50) - (position2027 ?? 50));
    return `
      <div class="chart-company-row">
        ${chartCompanyLabel(company)}
        <div class="leverage-visual">
          <span class="leverage-track" aria-label="CY2027 ${multiple(value2027)}, CY2028 ${multiple(value2028)}">
            ${zeroPosition === null ? "" : `<i class="leverage-zero" style="left:${zeroPosition}%" title="Zero leverage"></i>`}
            ${value2027 !== null && value2028 !== null ? `<i class="leverage-range" style="left:${rangeLeft}%;width:${rangeWidth}%"></i>` : ""}
            ${value2027 === null ? "" : `<i class="leverage-dot cy27" style="left:${position2027}%" title="CY2027 ${multiple(value2027)}"></i>`}
            ${value2028 === null ? "" : `<i class="leverage-dot cy28" style="left:${position2028}%" title="CY2028 ${multiple(value2028)}"></i>`}
          </span>
          <span class="leverage-values"><span class="v27">${multiple(value2027)}</span><span>→</span><span class="v28">${multiple(value2028)}</span></span>
        </div>
      </div>`;
  });
  return `<div class="metric-chart">${rows.join("")}</div>`;
}

function leveragePosition(value, domainMin, domainMax) {
  if (value === null) return null;
  return Math.max(0, Math.min(100, ((value - domainMin) / (domainMax - domainMin)) * 100));
}

function chartCompanyLabel(company) {
  return `<span class="chart-company-label"><strong title="${escapeHtml(company.company_name)}">${escapeHtml(company.company_name)}</strong><span>${escapeHtml(company.Ticker)}</span></span>`;
}

function renderChangeTable(companies) {
  elements.changeTableBody.innerHTML = companies.length
    ? companies
        .map((company) => {
          const epsGrowth = growth(company.cy2027_eps, company.cy2028_eps);
          const fcfGrowth = growth(company.cy2027_fcf, company.cy2028_fcf);
          const peChange = percentChange(company.cy2027_pe, company.cy2028_pe);
          const evFcfChange = percentChange(company.cy2027_ev_fcf, company.cy2028_ev_fcf);
          const leverageChange = difference(company.cy2027_leverage, company.cy2028_leverage);
          return `
            <tr>
              <td><span class="change-company"><strong>${escapeHtml(company.company_name)}</strong><span>${escapeHtml(company.Ticker)}</span></span></td>
              <td class="${deltaClass(epsGrowth)}">${signedPercent(epsGrowth)}</td>
              <td class="${deltaClass(fcfGrowth)}">${signedPercent(fcfGrowth)}</td>
              <td class="${deltaClass(peChange, true)}">${signedPercent(peChange)}</td>
              <td class="${deltaClass(evFcfChange, true)}">${signedPercent(evFcfChange)}</td>
              <td class="${deltaClass(leverageChange, true)}">${signedMultiple(leverageChange)}</td>
            </tr>`;
        })
        .join("")
    : '<tr><td colspan="6" class="option-empty">No companies selected</td></tr>';
}

function growth(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return null;
  return ((end / start) - 1) * 100;
}

function percentChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return ((end / start) - 1) * 100;
}

function difference(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

function deltaClass(value, lowerIsFavorable = false) {
  if (!Number.isFinite(value) || value === 0) return "delta-neutral";
  if (lowerIsFavorable) return value < 0 ? "delta-favorable" : "delta-unfavorable";
  return value > 0 ? "delta-positive" : "delta-negative";
}

function updateSelectionUrl() {
  const url = new URL(window.location.href);
  if (state.selectedIds.length) url.searchParams.set("companies", state.selectedIds.join(","));
  else url.searchParams.delete("companies");
  url.hash = state.activeView;
  history.replaceState(null, "", url);
}

async function copyComparisonLink() {
  const url = new URL(window.location.href);
  url.searchParams.set("companies", state.selectedIds.join(","));
  url.hash = "compare";
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("Comparison link copied.");
  } catch {
    window.prompt("Copy comparison link", url.toString());
  }
}

async function exportComparisonWorkbook(companies) {
  if (!companies.length) {
    showToast("There are no companies to export.");
    return;
  }

  await runExcelExport(elements.exportCompareButton, companies.length, async (ExcelJS) => {
    const workbook = createExportWorkbook(ExcelJS, "Selected semiconductor peer comparison");
    const identityColumns = getExportIdentityColumns();
    const comparableMetrics = [
      { key: "eps_usd", header: "EPS (USD/share)", width: 17, numberFormat: "$#,##0.00;[Red]($#,##0.00);-" },
      { key: "fcf_usd", header: "FCF/share (USD)", width: 18, numberFormat: "$#,##0.00;[Red]($#,##0.00);-" },
      { key: "pe", header: "P/E", width: 13, numberFormat: "0.00x;[Red](0.00x);-" },
      { key: "ev_fcf", header: "EV/FCF", width: 14, numberFormat: "0.00x;[Red](0.00x);-" },
      { key: "leverage", header: "Net leverage", width: 16, numberFormat: "0.00x;[Red](0.00x);-" },
    ];
    const yearColumns = [2027, 2028].flatMap((year) => comparableMetrics.map((metric) => ({
      ...metric,
      key: `cy${year}_${metric.key}`,
      value: (company) => company[`cy${year}_${metric.key}`],
      median: true,
    })));
    const changeColumns = [
      { header: "EPS growth (reported currency)", width: 25, numberFormat: "+0.0%;[Red]-0.0%;-", value: (company) => percentageDecimal(growth(company.cy2027_eps, company.cy2028_eps)), median: true },
      { header: "FCF/share growth (reported currency)", width: 28, numberFormat: "+0.0%;[Red]-0.0%;-", value: (company) => percentageDecimal(growth(company.cy2027_fcf, company.cy2028_fcf)), median: true },
      { header: "P/E change", width: 15, numberFormat: "+0.0%;[Red]-0.0%;-", value: (company) => percentageDecimal(percentChange(company.cy2027_pe, company.cy2028_pe)), median: true },
      { header: "EV/FCF change", width: 17, numberFormat: "+0.0%;[Red]-0.0%;-", value: (company) => percentageDecimal(percentChange(company.cy2027_ev_fcf, company.cy2028_ev_fcf)), median: true },
      { header: "Net leverage change", width: 20, numberFormat: "+0.00x;[Red]-0.00x;-", value: (company) => difference(company.cy2027_leverage, company.cy2028_leverage), median: true },
    ];
    const summaryColumns = [...identityColumns, ...yearColumns, ...changeColumns];
    const identitySpan = identityColumns.length;
    const summaryGroups = [
      { label: "Company profile", span: identitySpan, color: EXCEL_COLORS.navy },
      { label: "CY2027", span: comparableMetrics.length, color: EXCEL_COLORS.blue2027 },
      { label: "CY2028", span: comparableMetrics.length, color: EXCEL_COLORS.blue2028 },
      { label: "CY2028 vs CY2027", span: changeColumns.length, color: EXCEL_COLORS.orange },
    ];
    const peerRows = companies.map((company) => ({ values: rowValues(company, summaryColumns) }));
    peerRows.push({ values: medianRowValues(companies, summaryColumns), style: "median" });
    addProfessionalSheet(workbook, {
      name: "Peer Comparison",
      title: "Selected Peer Comparison",
      context: `${companies.length} companies | Calendar-normalized consensus estimates as of ${formatDate(getLatestForecastDate())} | Market capitalizations as of ${formatDate(latestMarketCapDate(companies))} | Per-share growth uses reporting currency`,
      columns: summaryColumns,
      groups: summaryGroups,
      rows: peerRows,
      freezeColumns: 2,
      tabColor: EXCEL_COLORS.blue2028,
    });

    const detailMetrics = [
      { key: "eps", header: "EPS (local/share)", width: 18, numberFormat: "#,##0.00;[Red](#,##0.00);-" },
      { key: "eps_usd", header: "EPS (USD/share)", width: 17, numberFormat: "$#,##0.00;[Red]($#,##0.00);-" },
      { key: "fcf", header: "FCF/share (local)", width: 19, numberFormat: "#,##0.00;[Red](#,##0.00);-" },
      { key: "fcf_usd", header: "FCF/share (USD)", width: 18, numberFormat: "$#,##0.00;[Red]($#,##0.00);-" },
      { key: "pe", header: "P/E", width: 13, numberFormat: "0.00x;[Red](0.00x);-" },
      { key: "ev_fcf", header: "EV/FCF", width: 14, numberFormat: "0.00x;[Red](0.00x);-" },
      { key: "leverage", header: "Net leverage", width: 16, numberFormat: "0.00x;[Red](0.00x);-" },
      { key: "quality", header: "Estimate quality", width: 18, type: "text" },
    ];
    const detailYearColumns = [2027, 2028].flatMap((year) => detailMetrics.map((metric) => ({
      ...metric,
      key: metric.key === "quality" ? `quality${year}` : `cy${year}_${metric.key}`,
      value: (company) => metric.key === "quality" ? company[`quality${year}`] : company[`cy${year}_${metric.key}`],
    })));
    const detailColumns = [...identityColumns, ...detailYearColumns];
    addProfessionalSheet(workbook, {
      name: "Detailed Values",
      title: "Detailed Valuation Values",
      context: `Local-currency and USD per-share values are shown separately; USD values are per underlying ordinary share. Estimates as of ${formatDate(getLatestForecastDate())} | Market capitalizations as of ${formatDate(latestMarketCapDate(companies))}`,
      columns: detailColumns,
      groups: [
        { label: "Company profile", span: identitySpan, color: EXCEL_COLORS.navy },
        { label: "CY2027", span: detailMetrics.length, color: EXCEL_COLORS.blue2027 },
        { label: "CY2028", span: detailMetrics.length, color: EXCEL_COLORS.blue2028 },
      ],
      rows: companies.map((company) => ({ values: rowValues(company, detailColumns) })),
      freezeColumns: 2,
      tabColor: EXCEL_COLORS.blue2027,
    });

    return {
      workbook,
      filename: `relative-valuation-peer-comparison-${localDateStamp()}.xlsx`,
    };
  });
}

async function exportMatrixView(companies) {
  if (!companies.length) {
    showToast("There are no companies to export.");
    return;
  }

  await runExcelExport(elements.exportMatrixButton, companies.length, async (ExcelJS) => {
    const workbook = createExportWorkbook(ExcelJS, "Current semiconductor valuation matrix view");
    const years = getVisibleYears();
    const metrics = getVisibleMatrixMetrics();
    const identityColumns = getExportIdentityColumns();
    const metricColumns = years.flatMap((year) => metrics.map((metric) => ({
      key: `cy${year}_${metric.key}`,
      header: matrixExportHeader(metric),
      width: metric.baseKey === "leverage" ? 16 : 15,
      numberFormat: exportNumberFormat(metric),
      value: (company) => company[`cy${year}_${metric.key}`],
    })));
    const columns = [...identityColumns, ...metricColumns];
    const groups = [
      { label: "Company profile", span: identityColumns.length, color: EXCEL_COLORS.navy },
      ...years.map((year) => ({
        label: `CY${year}`,
        span: metrics.length,
        color: year === 2027 ? EXCEL_COLORS.blue2027 : EXCEL_COLORS.blue2028,
      })),
    ];
    const metricNames = metrics.map((metric) => metric.label).join(", ");
    const unitLabel = state.perShareUnit === "usd" ? "USD per share" : "reporting currency per share";
    const filterParts = [
      state.category === "all" ? "All businesses" : state.category,
      state.query ? `Search: ${state.query}` : null,
    ].filter(Boolean);
    addProfessionalSheet(workbook, {
      name: "Valuation Matrix",
      title: "Relative Valuation Matrix",
      context: `${companies.length} companies | ${years.map((year) => `CY${year}`).join(" + ")} | ${metricNames} | ${unitLabel} | ${filterParts.join(" | ")} | Estimates as of ${formatDate(getLatestForecastDate())} | Market capitalizations as of ${formatDate(latestMarketCapDate(companies))}`,
      columns,
      groups,
      rows: companies.map((company) => ({ values: rowValues(company, columns) })),
      freezeColumns: 2,
      tabColor: years.length === 1 && years[0] === 2027 ? EXCEL_COLORS.blue2027 : EXCEL_COLORS.blue2028,
    });

    return {
      workbook,
      filename: `relative-valuation-matrix-view-${localDateStamp()}.xlsx`,
    };
  });
}

function createExportWorkbook(ExcelJS, subject) {
  const workbook = new ExcelJS.Workbook();
  const now = new Date();
  workbook.creator = "Relative Valuation Matrix";
  workbook.lastModifiedBy = "Relative Valuation Matrix";
  workbook.created = now;
  workbook.modified = now;
  workbook.subject = subject;
  workbook.title = "Relative Valuation Matrix";
  workbook.company = "Relative Valuation Matrix";
  workbook.category = "Semiconductor valuation";
  workbook.keywords = "semiconductors, relative valuation, calendarized estimates";
  return workbook;
}

function getExportIdentityColumns() {
  return [
    { key: "company_name", header: "Company", width: 30, type: "text" },
    { key: "Ticker", header: "Ticker", width: 14, type: "text" },
    { key: "market_cap_usd_bn", header: "Market cap (USD bn)", width: 20, numberFormat: "$#,##0.0;[Red]($#,##0.0);-", median: true },
  ];
}

function matrixExportHeader(metric) {
  if (metric.baseKey === "eps") return state.perShareUnit === "usd" ? "EPS (USD/share)" : "EPS (local/share)";
  if (metric.baseKey === "fcf") return state.perShareUnit === "usd" ? "FCF/share (USD)" : "FCF/share (local)";
  return {
    pe: "P/E",
    ev_fcf: "EV/FCF",
    leverage: "Net leverage",
  }[metric.baseKey] || metric.label;
}

function exportNumberFormat(metric) {
  if (metric.perShare && state.perShareUnit === "usd") return "$#,##0.00;[Red]($#,##0.00);-";
  if (metric.perShare) return "#,##0.00;[Red](#,##0.00);-";
  return "0.00x;[Red](0.00x);-";
}

function rowValues(company, columns) {
  return columns.map((column) => {
    const value = column.value ? column.value(company) : company[column.key];
    return value === null || value === undefined || value === "" ? INSUFFICIENT_DATA : value;
  });
}

function medianRowValues(companies, columns) {
  const identityLabels = {
    Ticker: "Selected set",
    country: "n.a.",
    segment: "Comparable metrics",
    reporting_currency: "USD",
    fiscal_year: "Calendarized",
  };
  return columns.map((column, index) => {
    if (index === 0) return "Peer median";
    if (!column.median) return identityLabels[column.key] || "n.a.";
    const value = median(companies.map((company) => column.value ? column.value(company) : company[column.key]));
    return value === null ? INSUFFICIENT_DATA : value;
  });
}

function addProfessionalSheet(workbook, options) {
  const sheet = workbook.addWorksheet(options.name, {
    properties: { tabColor: { argb: options.tabColor } },
    views: [{ state: "frozen", showGridLines: false, xSplit: Math.min(options.freezeColumns, options.columns.length - 1), ySplit: 6, topLeftCell: `${excelColumnName(options.freezeColumns + 1)}7`, activeCell: "A7" }],
  });
  const lastColumn = excelColumnName(options.columns.length);
  sheet.columns = options.columns.map((column) => ({ key: column.key, width: column.width }));
  sheet.views = [{ state: "frozen", showGridLines: false, xSplit: Math.min(options.freezeColumns, options.columns.length - 1), ySplit: 6, topLeftCell: `${excelColumnName(options.freezeColumns + 1)}7`, activeCell: "A7" }];
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
  sheet.headerFooter.oddFooter = "&LRelative Valuation Matrix&CPage &P of &N&RGenerated &D";

  sheet.getRow(1).height = 8;
  sheet.mergeCells(`A2:${lastColumn}2`);
  const titleCell = sheet.getCell("A2");
  titleCell.value = options.title;
  titleCell.font = { name: "Arial", size: 15, bold: true, color: { argb: EXCEL_COLORS.navy } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(2).height = 25;

  sheet.mergeCells(`A3:${lastColumn}3`);
  const contextCell = sheet.getCell("A3");
  contextCell.value = options.context;
  contextCell.font = { name: "Arial", size: 9, italic: true, color: { argb: EXCEL_COLORS.muted } };
  contextCell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  contextCell.border = { bottom: { style: "thin", color: { argb: EXCEL_COLORS.border } } };
  sheet.getRow(3).height = 28;
  sheet.getRow(4).height = 8;

  let groupStart = 1;
  options.groups.forEach((group) => {
    const groupEnd = groupStart + group.span - 1;
    if (group.span > 1) sheet.mergeCells(5, groupStart, 5, groupEnd);
    const cell = sheet.getCell(5, groupStart);
    cell.value = group.label;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: group.color } };
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: EXCEL_COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      left: { style: "thin", color: { argb: EXCEL_COLORS.white } },
      right: { style: "thin", color: { argb: EXCEL_COLORS.white } },
    };
    groupStart = groupEnd + 1;
  });
  sheet.getRow(5).height = 23;

  const headerRow = sheet.getRow(6);
  headerRow.values = options.columns.map((column) => column.header);
  headerRow.height = 35;
  let headerGroupIndex = 0;
  let headerGroupEnd = options.groups[0].span;
  options.columns.forEach((column, index) => {
    while (index + 1 > headerGroupEnd && headerGroupIndex < options.groups.length - 1) {
      headerGroupIndex += 1;
      headerGroupEnd += options.groups[headerGroupIndex].span;
    }
    const cell = headerRow.getCell(index + 1);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: options.groups[headerGroupIndex].color } };
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: EXCEL_COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      left: { style: "thin", color: { argb: EXCEL_COLORS.white } },
      right: { style: "thin", color: { argb: EXCEL_COLORS.white } },
      bottom: { style: "medium", color: { argb: EXCEL_COLORS.navy } },
    };
  });

  options.rows.forEach((rowData, rowIndex) => {
    const row = sheet.addRow(rowData.values);
    const isMedian = rowData.style === "median";
    row.height = options.columns.some((column) => column.wrap) ? 32 : 24;
    options.columns.forEach((column, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      const missing = cell.value === INSUFFICIENT_DATA;
      cell.font = {
        name: "Arial",
        size: 10,
        bold: isMedian,
        italic: missing,
        color: { argb: missing ? EXCEL_COLORS.missingText : isMedian ? EXCEL_COLORS.orange : EXCEL_COLORS.body },
      };
      cell.alignment = {
        vertical: "middle",
        horizontal: column.type === "text" || typeof cell.value === "string" ? "left" : "right",
        wrapText: Boolean(column.wrap),
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: isMedian ? EXCEL_COLORS.orangeSoft : missing ? EXCEL_COLORS.missingFill : rowIndex % 2 ? EXCEL_COLORS.band : EXCEL_COLORS.white },
      };
      cell.border = isMedian
        ? {
            top: { style: "medium", color: { argb: EXCEL_COLORS.orange } },
            bottom: { style: "medium", color: { argb: EXCEL_COLORS.orange } },
          }
        : { bottom: { style: "thin", color: { argb: EXCEL_COLORS.border } } };
      if (typeof cell.value === "number" && column.numberFormat) cell.numFmt = column.numberFormat;
    });
  });

  sheet.autoFilter = {
    from: { row: 6, column: 1 },
    to: { row: 6, column: options.columns.length },
  };
  return sheet;
}

async function runExcelExport(button, companyCount, buildWorkbook) {
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = '<span aria-hidden="true">&#8595;</span> Preparing Excel';
  try {
    const ExcelJS = await loadExcelJs();
    const { workbook, filename } = await buildWorkbook(ExcelJS);
    const buffer = await workbook.xlsx.writeBuffer();
    downloadExcel(buffer, filename);
    showToast(`${companyCount} companies exported to Excel.`);
  } catch (error) {
    console.error("Excel export failed", error);
    showToast("Excel export could not be created. Please try again.");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.innerHTML = originalHtml;
  }
}

async function loadExcelJs() {
  if (window.ExcelJS) return window.ExcelJS;
  if (!excelJsPromise) {
    excelJsPromise = (async () => {
      let lastError;
      for (const source of EXCELJS_SOURCES) {
        try {
          await loadScript(source);
          if (window.ExcelJS) return window.ExcelJS;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("ExcelJS did not initialize.");
    })().catch((error) => {
      excelJsPromise = null;
      throw error;
    });
  }
  return excelJsPromise;
}

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${source}`));
    document.head.appendChild(script);
  });
}

function downloadExcel(buffer, filename) {
  const blob = new Blob([buffer], { type: EXCEL_MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function latestMarketCapDate(companies) {
  return companies.map((company) => company.market_cap_as_of).filter(Boolean).sort().at(-1) || "";
}

function percentageDecimal(value) {
  return Number.isFinite(value) ? value / 100 : null;
}

function localDateStamp() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function excelColumnName(columnNumber) {
  let value = columnNumber;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2400);
}

function median(values) {
  const numbers = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function formatMetric(value, key) {
  if (!Number.isFinite(value)) return INSUFFICIENT_DATA;
  const absolute = Math.abs(value);
  if (key === "pe" || key === "ev_fcf" || key === "leverage" || key === "multiple") return formatNumber(value, 2);
  if (absolute >= 100000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  if (absolute >= 1000) return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  if (absolute >= 100) return formatNumber(value, 1);
  return formatNumber(value, 2);
}

function formatFull(value, key) {
  if (!Number.isFinite(value)) return INSUFFICIENT_DATA;
  const isPerShare = key === "eps" || key === "fcf" || key === "eps_usd" || key === "fcf_usd";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: isPerShare ? 4 : 2 }).format(value);
}

function formatNumber(value, decimals = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(value);
}

function multiple(value) {
  return Number.isFinite(value) ? `${formatNumber(value, 2)}x` : INSUFFICIENT_DATA;
}

function signedMultiple(value) {
  if (!Number.isFinite(value)) return INSUFFICIENT_DATA;
  return `${value > 0 ? "+" : ""}${formatNumber(value, 2)}x`;
}

function percent(value) {
  return Number.isFinite(value) ? `${formatNumber(value, 1)}%` : INSUFFICIENT_DATA;
}

function signedPercent(value) {
  if (!Number.isFinite(value)) return INSUFFICIENT_DATA;
  return `${value > 0 ? "+" : ""}${formatNumber(value, 1)}%`;
}

function formatMarketCap(value) {
  if (!Number.isFinite(value)) return INSUFFICIENT_DATA;
  if (value >= 1000) return `$${formatNumber(value / 1000, 2)}T`;
  return `$${formatNumber(value, 1)}B`;
}

function formatDate(value) {
  if (!value) return INSUFFICIENT_DATA;
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
