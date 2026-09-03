"use strict";

const DATA_PATHS = {
  universe: "data/semiconductor_universe.csv",
  calendarized: "data/calendarized_metrics.csv",
};

const MAX_SELECTION = 10;
const INSUFFICIENT_DATA = "Insufficient Data";
const DEFAULT_SELECTION = ["nvidia", "tsmc", "broadcom"];
const METRICS = [
  { key: "eps", label: "EPS", chart: "growth", unit: "reported currency / share" },
  { key: "fcf", label: "FCF / share", chart: "growth", unit: "reported currency / share" },
  { key: "pe", label: "P / E", chart: "bars", unit: "multiple" },
  { key: "ev_fcf", label: "EV / FCF", chart: "bars", unit: "multiple" },
  { key: "leverage", label: "Net leverage", chart: "leverage", unit: "net debt / EBITDA" },
];

const state = {
  companies: [],
  selectedIds: [],
  activeView: "matrix",
  query: "",
  category: "all",
  sortKey: "market_cap_usd_bn",
  sortDirection: "desc",
  optionIndex: -1,
  toastTimer: null,
};

const elements = {};

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
    "matrixResultCount",
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

  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.addEventListener("click", () => setSort(button.dataset.sort));
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
  elements.exportCompareButton.addEventListener("click", () => exportCompanies(getSelectedCompanies(), "selected-peer-comparison.csv"));
  elements.exportMatrixButton.addEventListener("click", () => exportCompanies(getFilteredCompanies(), "valuation-matrix-view.csv"));
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
    cy2027_fcf: numeric(row["CY2027 FCF/share"]),
    cy2027_pe: numeric(row["CY2027 P/E"]),
    cy2027_ev_fcf: numeric(row["CY2027 EV/FCF"]),
    cy2027_leverage: numeric(row["CY2027 Net leverage"]),
    cy2028_eps: numeric(row["CY2028 EPS"]),
    cy2028_fcf: numeric(row["CY2028 FCF/share"]),
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
  const companies = getFilteredCompanies();
  const selected = new Set(state.selectedIds);

  elements.matrixResultCount.textContent = `${companies.length} ${companies.length === 1 ? "company" : "companies"}`;
  elements.matrixBody.innerHTML = companies.length
    ? companies.map((company) => matrixRow(company, selected.has(company.id))).join("")
    : '<tr class="empty-row"><td colspan="14">No companies match the current filters.</td></tr>';

  document.querySelectorAll("[data-sort]").forEach((button) => {
    if (button.dataset.sort === state.sortKey) button.dataset.direction = state.sortDirection;
    else button.removeAttribute("data-direction");
  });
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
    state.sortDirection = key === "company_name" || key === "Ticker" ? "asc" : "desc";
  }
  renderMatrix();
}

function matrixRow(company, isSelected) {
  const metrics2027 = METRICS.map((metric) => metricCell(company, 2027, metric)).join("");
  const metrics2028 = METRICS.map((metric) => metricCell(company, 2028, metric)).join("");
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
      ${metrics2027}
      ${metrics2028}
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
  if (metric.key === "eps" || metric.key === "fcf") titleParts.push(company.reporting_currency);
  titleParts.push(`Quality: ${quality}`);
  const marker = quality === "flat-tail" ? '<i class="quality-marker" aria-label="Flat-tail estimate"></i>' : "";
  return `<td title="${escapeHtml(titleParts.join(" | "))}">${value === null ? `<span class="metric-missing">${INSUFFICIENT_DATA}</span>` : `<span class="metric-value">${formatMetric(value, metric.key)}</span>${marker}`}</td>`;
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
  const stats = [
    ["Selected companies", String(companies.length), "of 10"],
    ["Median CY2027 P/E", multiple(median(companies.map((company) => company.cy2027_pe))), "peer set"],
    ["Median CY2028 P/E", multiple(median(companies.map((company) => company.cy2028_pe))), "peer set"],
    ["Median CY2027 EV/FCF", multiple(median(companies.map((company) => company.cy2027_ev_fcf))), "peer set"],
    ["Median CY2028 EV/FCF", multiple(median(companies.map((company) => company.cy2028_ev_fcf))), "peer set"],
  ];
  elements.peerStats.innerHTML = stats
    .map(([label, value, note]) => `<div class="peer-stat"><span>${label}</span><strong>${value}<small>${note}</small></strong></div>`)
    .join("");
}

function renderCharts(companies) {
  elements.comparisonCharts.innerHTML = METRICS.map((metric) => metricPanel(metric, companies)).join("");
}

function metricPanel(metric, companies) {
  const title = metric.chart === "growth" ? `${metric.label} growth` : metric.label;
  const context = metric.chart === "growth" ? "CY2027 to CY2028 · reported currency" : metric.unit;
  const available = companies.filter((company) => company[`cy2027_${metric.key}`] !== null || company[`cy2028_${metric.key}`] !== null).length;
  const summaryValue = metric.chart === "growth"
    ? percent(median(companies.map((company) => growth(company[`cy2027_${metric.key}`], company[`cy2028_${metric.key}`]))))
    : multiple(median(companies.map((company) => company[`cy2028_${metric.key}`])));

  return `
    <section class="metric-panel" aria-labelledby="chart-${metric.key}">
      <header class="metric-panel-header">
        <div>
          <h2 id="chart-${metric.key}">${escapeHtml(title)}</h2>
          <p>${escapeHtml(context)}</p>
        </div>
      <span class="metric-panel-summary">${available} of ${companies.length}<strong>${summaryValue}</strong></span>
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
  const limit = Math.max(...values.map(Math.abs), 1) * 1.12;
  const rows = companies.map((company) => {
    const value2027 = company.cy2027_leverage;
    const value2028 = company.cy2028_leverage;
    const position2027 = leveragePosition(value2027, limit);
    const position2028 = leveragePosition(value2028, limit);
    const rangeLeft = Math.min(position2027 ?? 50, position2028 ?? 50);
    const rangeWidth = Math.abs((position2028 ?? 50) - (position2027 ?? 50));
    return `
      <div class="chart-company-row">
        ${chartCompanyLabel(company)}
        <div class="leverage-visual">
          <span class="leverage-track" aria-label="CY2027 ${multiple(value2027)}, CY2028 ${multiple(value2028)}">
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

function leveragePosition(value, limit) {
  if (value === null) return null;
  return Math.max(0, Math.min(100, 50 + (value / limit) * 50));
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

function exportCompanies(companies, filename) {
  if (!companies.length) {
    showToast("There are no companies to export.");
    return;
  }
  const headers = [
    "Company",
    "Ticker",
    "Country",
    "Business",
    "Market Cap USD Bn",
    "Reporting Currency",
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
  const rows = companies.map((company) => [
    company.company_name,
    company.Ticker,
    company.country,
    company.segment,
    company.market_cap_usd_bn,
    company.reporting_currency,
    company.cy2027_eps,
    company.cy2027_fcf,
    company.cy2027_pe,
    company.cy2027_ev_fcf,
    company.cy2027_leverage,
    company.cy2028_eps,
    company.cy2028_fcf,
    company.cy2028_pe,
    company.cy2028_ev_fcf,
    company.cy2028_leverage,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  showToast(`${companies.length} companies exported.`);
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: key === "eps" || key === "fcf" ? 4 : 2 }).format(value);
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
