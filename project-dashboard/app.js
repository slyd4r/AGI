(function () {
  "use strict";

  const config = window.DASHBOARD_CONFIG || {};
  const PAGE_SIZE = 15;
  const CHART_COLORS = ["#0f8f83", "#2f6fed", "#f58a07", "#d84a4a", "#7b61c9", "#5b7083", "#16a085", "#8c6a2f"];
  const SENSITIVE_LABEL = /(?:^|\s)(?:password|passwd|user|username|user name|role|credential|login|email|token|secret|pin|otp|authentication|auth code|access key|api key)(?:\s|$)/i;

  const TRADE_DEFINITIONS = [
    { label: "Carpenter", pattern: /\bcarpenter|carpentry\b/i },
    { label: "Steel Fixer", pattern: /\bsteel fixer|steel fixing|rebar\b/i },
    { label: "Mason", pattern: /\bmason|masonry\b/i },
    { label: "Helper", pattern: /\bhelper|labou?rer\b/i },
    { label: "Scaffolder", pattern: /\bscaffold(?:er|ing)?\b/i },
    { label: "Rigger", pattern: /\brigger|rigging\b/i },
    { label: "Flagman", pattern: /\bflagman|banksman\b/i },
    { label: "Surveyor Assistant", pattern: /\bsurveyor assistant|survey assistant\b/i },
  ];

  const state = {
    selectedDefinitions: [],
    columns: [],
    rows: [],
    filteredRows: [],
    model: {},
    page: 1,
    activeScripts: new Set(),
  };

  const elements = {
    title: document.getElementById("dashboard-title"),
    syncStatus: document.getElementById("sync-status"),
    syncDot: document.querySelector(".sync-dot"),
    refreshButton: document.getElementById("refresh-button"),
    searchInput: document.getElementById("search-input"),
    activityWrap: document.getElementById("category-filter-wrap"),
    activityLabel: document.getElementById("category-filter-label"),
    activityFilter: document.getElementById("category-filter"),
    locationWrap: document.getElementById("location-filter-wrap"),
    locationLabel: document.getElementById("location-filter-label"),
    locationFilter: document.getElementById("location-filter"),
    tradeWrap: document.getElementById("trade-filter-wrap"),
    tradeFilter: document.getElementById("trade-filter"),
    clearFilters: document.getElementById("clear-filters"),
    recordSummary: document.getElementById("record-summary"),
    errorPanel: document.getElementById("error-panel"),
    errorMessage: document.getElementById("error-message"),
    retryButton: document.getElementById("retry-button"),
    kpiGrid: document.getElementById("kpi-grid"),
    chartGrid: document.getElementById("chart-grid"),
    tradeChart: document.getElementById("status-chart"),
    activityChart: document.getElementById("category-chart"),
    locationPanel: document.getElementById("trend-panel"),
    locationTitle: document.getElementById("trend-chart-title"),
    locationCaption: document.getElementById("trend-caption"),
    locationChart: document.getElementById("trend-chart"),
    tablePanel: document.getElementById("table-panel"),
    table: document.getElementById("data-table"),
    tableCount: document.getElementById("table-count"),
    previousPage: document.getElementById("previous-page"),
    nextPage: document.getElementById("next-page"),
    pageStatus: document.getElementById("page-status"),
    emptyPanel: document.getElementById("empty-panel"),
  };

  function normaliseLabel(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[_\-]+/g, " ")
      .replace(/[^a-z0-9% ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSensitive(label) {
    return SENSITIVE_LABEL.test(normaliseLabel(label));
  }

  function columnLetter(index) {
    let number = index + 1;
    let letters = "";
    while (number > 0) {
      const remainder = (number - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      number = Math.floor((number - 1) / 26);
    }
    return letters;
  }

  function formatNumber(value, maximumFractionDigits = 1) {
    return new Intl.NumberFormat(config.locale || "en-GB", {
      maximumFractionDigits,
    }).format(Number.isFinite(value) ? value : 0);
  }

  function numberValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/,/g, "").trim();
    if (!cleaned) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }

  function displayCell(row, index) {
    const cell = row.cells[index];
    if (!cell || cell.value === null || cell.value === undefined || cell.value === "") return "—";
    if (cell.formatted !== null && cell.formatted !== undefined && cell.formatted !== "") {
      return String(cell.formatted);
    }
    if (typeof cell.value === "number") return formatNumber(cell.value);
    if (typeof cell.value === "boolean") return cell.value ? "Yes" : "No";
    return String(cell.value);
  }

  function rawCell(row, index) {
    if (index === null || index === undefined || index < 0) return null;
    return row.cells[index]?.value ?? null;
  }

  function querySheet(query) {
    return new Promise((resolve, reject) => {
      if (!config.spreadsheetId) {
        reject(new Error("The spreadsheet ID is missing."));
        return;
      }

      const callbackName = `__qtySheetResponse_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      let timeoutId;

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        delete window[callbackName];
        state.activeScripts.delete(script);
        script.remove();
      };

      window[callbackName] = (response) => {
        cleanup();
        if (!response || response.status === "error" || !response.table) {
          const message = response?.errors
            ?.map((error) => error.message || error.detailed_message)
            .filter(Boolean)
            .join(" ");
          reject(new Error(message || "Google did not return readable QTY_Sheet data."));
          return;
        }
        resolve(response.table);
      };

      const params = new URLSearchParams({
        sheet: config.sheetName || "QTY_Sheet",
        headers: String(config.headers ?? 1),
        tq: query,
        tqx: `out:json;responseHandler:${callbackName};reqId:${Date.now()}`,
      });
      script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
        config.spreadsheetId,
      )}/gviz/tq?${params.toString()}`;
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new Error("QTY_Sheet did not respond. Check its name and sharing settings."));
      };
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("The QTY_Sheet request timed out."));
      }, 18000);

      state.activeScripts.add(script);
      document.head.appendChild(script);
    });
  }

  function scoreLabel(label, patterns) {
    const normalised = normaliseLabel(label);
    let score = 0;
    patterns.forEach(({ pattern, weight }) => {
      if (pattern.test(normalised)) score = Math.max(score, weight);
    });
    return score;
  }

  function chooseColumn(columns, patterns, usedIndexes) {
    let best = null;
    columns.forEach((column) => {
      if (usedIndexes.has(column.originalIndex) || isSensitive(column.label)) return;
      const score = scoreLabel(column.label, patterns);
      if (score > 0 && (!best || score > best.score)) best = { column, score };
    });
    return best?.column || null;
  }

  function classifyMandayColumn(column) {
    if (isSensitive(column.label)) return null;
    const label = normaliseLabel(column.label);
    if (!label) return null;

    const isTotal = /\btotal\b/.test(label) && /\bman ?days?\b|\bmandays?\b/.test(label);
    if (isTotal) return { ...column, role: "manday", kind: "total", displayLabel: "Total Mandays" };

    const trade = TRADE_DEFINITIONS.find((definition) => definition.pattern.test(label));
    if (trade) return { ...column, role: "manday", kind: "trade", displayLabel: trade.label };

    if (/\bman ?days?\b|\bmandays?\b|\bassigned manpower\b|\bmanpower\b/.test(label)) {
      return { ...column, role: "manday", kind: "generic", displayLabel: column.label };
    }
    return null;
  }

  function selectSafeColumns(metadataColumns) {
    const columns = metadataColumns.map((column, originalIndex) => ({
      ...column,
      originalIndex,
      label: String(column.label || column.id || `Column ${originalIndex + 1}`).trim(),
    }));
    const used = new Set();
    const selected = [];

    const roleDefinitions = [
      {
        role: "cluster",
        patterns: [
          { pattern: /^cluster$/, weight: 100 },
          { pattern: /\bcluster\b/, weight: 70 },
        ],
      },
      {
        role: "villa",
        patterns: [
          { pattern: /^villa$/, weight: 100 },
          { pattern: /villa number|villa no|emaar number/, weight: 90 },
          { pattern: /\bvilla\b/, weight: 70 },
        ],
      },
      {
        role: "area",
        patterns: [
          { pattern: /^area$/, weight: 100 },
          { pattern: /work area|location area/, weight: 85 },
          { pattern: /\barea\b/, weight: 65 },
        ],
      },
      {
        role: "section",
        patterns: [{ pattern: /^section$|work section/, weight: 90 }],
      },
      {
        role: "package",
        patterns: [{ pattern: /^package$|work package/, weight: 90 }],
      },
      {
        role: "location",
        patterns: [{ pattern: /^location$|work location/, weight: 90 }],
      },
      {
        role: "zone",
        patterns: [{ pattern: /^zone$|work zone/, weight: 90 }],
      },
      {
        role: "costCode",
        patterns: [{ pattern: /^cost code$|activity code|wbs code/, weight: 90 }],
      },
      {
        role: "activity",
        patterns: [
          { pattern: /^activity$/, weight: 120 },
          { pattern: /assigned activity|activity name|work activity/, weight: 110 },
          { pattern: /\bactivity\b/, weight: 90 },
          { pattern: /^task$|task name/, weight: 80 },
          { pattern: /work item|work description/, weight: 75 },
          { pattern: /^description$/, weight: 55 },
        ],
      },
      {
        role: "discipline",
        patterns: [{ pattern: /^discipline$|work discipline/, weight: 90 }],
      },
    ];

    roleDefinitions.forEach((definition) => {
      const column = chooseColumn(columns, definition.patterns, used);
      if (!column) return;
      selected.push({ ...column, role: definition.role, kind: "context", displayLabel: column.label });
      used.add(column.originalIndex);
    });

    columns.forEach((column) => {
      if (used.has(column.originalIndex)) return;
      const manday = classifyMandayColumn(column);
      if (!manday) return;
      selected.push(manday);
      used.add(column.originalIndex);
    });

    if (!selected.some((column) => column.role === "activity")) {
      throw new Error("No Activity column was found in QTY_Sheet.");
    }
    if (!selected.some((column) => column.role === "manday")) {
      throw new Error("No manday or recognised trade columns were found in QTY_Sheet.");
    }
    return selected;
  }

  function buildModel() {
    const roleIndex = (role) => state.columns.findIndex((column) => column.role === role);
    const tradeIndexes = [];
    const genericMandayIndexes = [];
    let totalMandayIndex = -1;

    state.columns.forEach((column, index) => {
      if (column.role !== "manday") return;
      if (column.kind === "total" && totalMandayIndex < 0) totalMandayIndex = index;
      else if (column.kind === "trade") tradeIndexes.push(index);
      else if (column.kind === "generic") genericMandayIndexes.push(index);
    });

    const locationPriority = ["villa", "area", "cluster", "location", "section", "zone", "package"];
    const locationRole = locationPriority.find((role) => roleIndex(role) >= 0) || null;
    return {
      activityIndex: roleIndex("activity"),
      locationIndex: locationRole ? roleIndex(locationRole) : -1,
      locationRole,
      tradeIndexes,
      genericMandayIndexes,
      totalMandayIndex,
      contextIndexes: state.columns
        .map((column, index) => (column.kind === "context" ? index : -1))
        .filter((index) => index >= 0),
    };
  }

  function rowMandays(row, selectedTrade = "") {
    if (selectedTrade) {
      const index = state.columns.findIndex(
        (column) => column.role === "manday" && column.displayLabel === selectedTrade,
      );
      return Math.max(0, numberValue(rawCell(row, index)) || 0);
    }

    if (state.model.totalMandayIndex >= 0) {
      const total = numberValue(rawCell(row, state.model.totalMandayIndex));
      if (total !== null) return Math.max(0, total);
    }

    const indexes = state.model.tradeIndexes.length
      ? state.model.tradeIndexes
      : state.model.genericMandayIndexes;
    return indexes.reduce(
      (sum, index) => sum + Math.max(0, numberValue(rawCell(row, index)) || 0),
      0,
    );
  }

  function countBy(rows, labelForRow, valueForRow) {
    const values = new Map();
    rows.forEach((row) => {
      const label = String(labelForRow(row) || "Unassigned").trim() || "Unassigned";
      values.set(label, (values.get(label) || 0) + valueForRow(row));
    });
    return [...values.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }

  function setLoading(loading) {
    elements.refreshButton.disabled = loading;
    elements.refreshButton.classList.toggle("is-loading", loading);
    if (loading) {
      elements.syncStatus.textContent = "Loading QTY_Sheet…";
      elements.syncDot.classList.remove("is-live", "is-error");
    }
  }

  async function loadSheet() {
    if (elements.refreshButton.classList.contains("is-loading")) return;
    setLoading(true);
    elements.errorPanel.hidden = true;
    try {
      const metadata = await querySheet("select * limit 0");
      state.selectedDefinitions = selectSafeColumns(metadata.cols || []);
      const selectedLetters = state.selectedDefinitions
        .map((column) => columnLetter(column.originalIndex))
        .join(",");
      const table = await querySheet(`select ${selectedLetters}`);

      state.columns = state.selectedDefinitions.map((definition, index) => ({
        ...definition,
        type: table.cols?.[index]?.type || definition.type || "string",
        label: definition.displayLabel || definition.label,
      }));
      state.rows = (table.rows || [])
        .map((row, rowIndex) => ({
          id: rowIndex,
          cells: state.columns.map((_, columnIndex) => ({
            value: row.c?.[columnIndex]?.v ?? null,
            formatted: row.c?.[columnIndex]?.f ?? null,
          })),
        }))
        .filter((row) => row.cells.some((cell) => cell.value !== null && cell.value !== ""));
      state.model = buildModel();
      state.page = 1;
      populateFilters();
      applyFilters();
      elements.syncDot.classList.add("is-live");
      elements.syncDot.classList.remove("is-error");
      elements.syncStatus.textContent = `Updated ${new Intl.DateTimeFormat(config.locale || "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: config.timeZone || undefined,
      }).format(new Date())}`;
    } catch (error) {
      showError(error.message || "QTY_Sheet could not be read.");
    } finally {
      setLoading(false);
    }
  }

  function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorPanel.hidden = false;
    elements.chartGrid.hidden = true;
    elements.tablePanel.hidden = true;
    elements.emptyPanel.hidden = true;
    elements.recordSummary.textContent = "No assignment data loaded";
    elements.syncDot.classList.remove("is-live");
    elements.syncDot.classList.add("is-error");
    elements.syncStatus.textContent = "QTY_Sheet unavailable";
    renderKpis([
      { label: "Assigned mandays", value: "—", note: "Waiting for QTY_Sheet", color: "#f58a07" },
      { label: "Activities", value: "—", note: "Waiting for QTY_Sheet", color: "#0f8f83" },
      { label: "Assignments", value: "—", note: "Waiting for QTY_Sheet", color: "#2f6fed" },
      { label: "Locations", value: "—", note: "Waiting for QTY_Sheet", color: "#7b61c9" },
    ]);
  }

  function populateSelect(select, values, allLabel) {
    const previous = select.value;
    select.replaceChildren();
    const first = document.createElement("option");
    first.value = "";
    first.textContent = allLabel;
    select.appendChild(first);
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = values.includes(previous) ? previous : "";
  }

  function uniqueValues(index) {
    if (index < 0) return [];
    return [...new Set(state.rows.map((row) => displayCell(row, index)).filter((value) => value !== "—"))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function populateFilters() {
    const activities = uniqueValues(state.model.activityIndex);
    populateSelect(elements.activityFilter, activities, "All activities");
    elements.activityWrap.hidden = activities.length < 2;

    if (state.model.locationIndex >= 0) {
      const locations = uniqueValues(state.model.locationIndex);
      const label = state.columns[state.model.locationIndex].label;
      elements.locationLabel.textContent = label;
      populateSelect(elements.locationFilter, locations, `All ${label.toLowerCase()}`);
      elements.locationWrap.hidden = locations.length < 2;
    } else {
      elements.locationWrap.hidden = true;
    }

    const tradeLabels = [...new Set(
      [...state.model.tradeIndexes, ...state.model.genericMandayIndexes]
        .map((index) => state.columns[index].displayLabel)
        .filter(Boolean),
    )];
    populateSelect(elements.tradeFilter, tradeLabels, "All trades");
    elements.tradeWrap.hidden = tradeLabels.length < 2;
  }

  function applyFilters() {
    const query = elements.searchInput.value.trim().toLowerCase();
    const activity = elements.activityFilter.value;
    const location = elements.locationFilter.value;
    const trade = elements.tradeFilter.value;

    state.filteredRows = state.rows.filter((row) => {
      if (activity && displayCell(row, state.model.activityIndex) !== activity) return false;
      if (location && displayCell(row, state.model.locationIndex) !== location) return false;
      if (trade && rowMandays(row, trade) <= 0) return false;
      if (query) {
        const searchable = state.model.contextIndexes
          .map((index) => displayCell(row, index))
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      return true;
    });

    state.page = Math.min(
      state.page,
      Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE)),
    );
    const hasFilters = Boolean(query || activity || location || trade);
    elements.clearFilters.hidden = !hasFilters;
    elements.recordSummary.textContent = hasFilters
      ? `${formatNumber(state.filteredRows.length, 0)} of ${formatNumber(state.rows.length, 0)} assignments shown`
      : `${formatNumber(state.rows.length, 0)} assignments loaded from QTY_Sheet`;
    renderDashboard();
  }

  function renderDashboard() {
    renderKpiSummary();
    if (!state.filteredRows.length) {
      elements.chartGrid.hidden = true;
      elements.tablePanel.hidden = true;
      elements.emptyPanel.hidden = false;
      return;
    }
    elements.emptyPanel.hidden = true;
    elements.chartGrid.hidden = false;
    elements.tablePanel.hidden = false;
    renderTradeChart();
    renderActivityChart();
    renderLocationChart();
    renderTable();
  }

  function renderKpiSummary() {
    const trade = elements.tradeFilter.value;
    const totalMandays = state.filteredRows.reduce((sum, row) => sum + rowMandays(row, trade), 0);
    const activities = new Set(
      state.filteredRows
        .map((row) => displayCell(row, state.model.activityIndex))
        .filter((value) => value !== "—"),
    );
    const locations = new Set(
      state.filteredRows
        .map((row) => displayCell(row, state.model.locationIndex))
        .filter((value) => value !== "—"),
    );
    const tradeCount = [...state.model.tradeIndexes, ...state.model.genericMandayIndexes]
      .filter((index) => state.filteredRows.some((row) => (numberValue(rawCell(row, index)) || 0) > 0))
      .length;

    renderKpis([
      {
        label: trade ? `${trade} mandays` : "Assigned mandays",
        value: formatNumber(totalMandays),
        note: "Total across visible assignments",
        color: "#f58a07",
      },
      {
        label: "Activities assigned",
        value: formatNumber(activities.size, 0),
        note: "Distinct visible activities",
        color: "#0f8f83",
      },
      {
        label: "Assignment rows",
        value: formatNumber(state.filteredRows.length, 0),
        note: "Visible QTY_Sheet entries",
        color: "#2f6fed",
      },
      {
        label: state.model.locationIndex >= 0 ? "Locations" : "Active trades",
        value: formatNumber(state.model.locationIndex >= 0 ? locations.size : tradeCount, 0),
        note:
          state.model.locationIndex >= 0
            ? state.columns[state.model.locationIndex].label
            : "Trades with assigned mandays",
        color: "#7b61c9",
      },
    ]);
  }

  function renderKpis(metrics) {
    elements.kpiGrid.replaceChildren();
    metrics.forEach((metric) => {
      const card = document.createElement("article");
      card.className = "kpi-card";
      card.style.setProperty("--kpi-color", metric.color);
      const label = document.createElement("span");
      label.className = "kpi-label";
      label.textContent = metric.label;
      const value = document.createElement("strong");
      value.className = "kpi-value";
      value.textContent = metric.value;
      const note = document.createElement("i");
      note.className = "kpi-note";
      note.textContent = metric.note;
      card.append(label, value, note);
      elements.kpiGrid.appendChild(card);
    });
  }

  function renderTradeChart() {
    elements.tradeChart.replaceChildren();
    const selectedTrade = elements.tradeFilter.value;
    const indexes = selectedTrade
      ? state.columns
          .map((column, index) =>
            column.role === "manday" && column.displayLabel === selectedTrade ? index : -1,
          )
          .filter((index) => index >= 0)
      : [...state.model.tradeIndexes, ...state.model.genericMandayIndexes];
    const items = indexes
      .map((index) => ({
        label: state.columns[index].displayLabel,
        value: state.filteredRows.reduce(
          (sum, row) => sum + Math.max(0, numberValue(rawCell(row, index)) || 0),
          0,
        ),
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const total = items.reduce((sum, item) => sum + item.value, 0);

    if (!total) {
      renderChartEmpty(elements.tradeChart, "No trade mandays match these filters.");
      return;
    }

    let current = 0;
    const stops = items.map((item, index) => {
      const start = (current / total) * 100;
      current += item.value;
      const end = (current / total) * 100;
      return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${end}%`;
    });
    const donut = document.createElement("div");
    donut.className = "donut";
    donut.style.setProperty("--donut-stops", stops.join(", "));
    donut.setAttribute("role", "img");
    donut.setAttribute(
      "aria-label",
      items.map((item) => `${item.label}: ${formatNumber(item.value)} mandays`).join(", "),
    );
    const center = document.createElement("div");
    center.className = "donut-center";
    const strong = document.createElement("strong");
    strong.textContent = formatNumber(total);
    const caption = document.createElement("span");
    caption.textContent = "mandays";
    center.append(strong, caption);
    donut.appendChild(center);

    const legend = document.createElement("ul");
    legend.className = "legend";
    items.forEach((item, index) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.setProperty("--legend-color", CHART_COLORS[index % CHART_COLORS.length]);
      const label = document.createElement("span");
      label.className = "legend-name";
      label.textContent = item.label;
      const value = document.createElement("span");
      value.className = "legend-value";
      value.textContent = formatNumber(item.value);
      li.append(dot, label, value);
      legend.appendChild(li);
    });
    elements.tradeChart.append(donut, legend);
  }

  function renderActivityChart() {
    elements.activityChart.replaceChildren();
    const trade = elements.tradeFilter.value;
    const items = countBy(
      state.filteredRows,
      (row) => displayCell(row, state.model.activityIndex),
      (row) => rowMandays(row, trade),
    )
      .filter((item) => item.value > 0)
      .slice(0, 10);
    renderBars(elements.activityChart, items, "No assigned mandays match these activities.");
  }

  function renderLocationChart() {
    if (state.model.locationIndex < 0) {
      elements.locationPanel.hidden = true;
      return;
    }
    const trade = elements.tradeFilter.value;
    const items = countBy(
      state.filteredRows,
      (row) => displayCell(row, state.model.locationIndex),
      (row) => rowMandays(row, trade),
    )
      .filter((item) => item.value > 0)
      .slice(0, 14);
    if (!items.length) {
      elements.locationPanel.hidden = true;
      return;
    }

    elements.locationPanel.hidden = false;
    elements.locationTitle.textContent = `Mandays by ${state.columns[state.model.locationIndex].label}`;
    elements.locationCaption.textContent = `Top ${items.length}`;
    elements.locationChart.replaceChildren();
    const bars = document.createElement("div");
    bars.className = "trend-bars";
    const maximum = Math.max(...items.map((item) => item.value), 1);
    items.forEach((item, index) => {
      const wrapper = document.createElement("div");
      wrapper.className = "trend-item";
      wrapper.title = `${item.label}: ${formatNumber(item.value)} mandays`;
      const column = document.createElement("span");
      column.className = "trend-column";
      column.style.height = `${Math.max(2, (item.value / maximum) * 100)}%`;
      column.style.animationDelay = `${index * 30}ms`;
      const label = document.createElement("span");
      label.className = "trend-label";
      label.textContent = item.label;
      wrapper.append(column, label);
      bars.appendChild(wrapper);
    });
    elements.locationChart.appendChild(bars);
  }

  function renderBars(container, items, emptyMessage) {
    if (!items.length) {
      renderChartEmpty(container, emptyMessage);
      return;
    }
    const maximum = Math.max(...items.map((item) => item.value), 1);
    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = item.label;
      label.title = item.label;
      const track = document.createElement("span");
      track.className = "bar-track";
      const fill = document.createElement("span");
      fill.className = "bar-fill";
      fill.style.width = `${(item.value / maximum) * 100}%`;
      fill.style.animationDelay = `${index * 35}ms`;
      track.appendChild(fill);
      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = formatNumber(item.value);
      row.append(label, track, value);
      container.appendChild(row);
    });
  }

  function renderTable() {
    const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = state.filteredRows.slice(start, start + PAGE_SIZE);
    const trade = elements.tradeFilter.value;
    const selectedIndexes = trade
      ? [
          ...state.model.contextIndexes,
          ...state.columns
            .map((column, index) =>
              column.role === "manday" && column.displayLabel === trade ? index : -1,
            )
            .filter((index) => index >= 0),
        ]
      : state.columns.map((_, index) => index);

    const thead = elements.table.querySelector("thead");
    const tbody = elements.table.querySelector("tbody");
    thead.replaceChildren();
    tbody.replaceChildren();
    const headerRow = document.createElement("tr");
    selectedIndexes.forEach((index) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = state.columns[index].displayLabel || state.columns[index].label;
      headerRow.appendChild(th);
    });
    if (state.model.totalMandayIndex < 0 || trade) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = trade ? `${trade} Mandays` : "Total Mandays";
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);

    pageRows.forEach((row) => {
      const tr = document.createElement("tr");
      selectedIndexes.forEach((index) => {
        const td = document.createElement("td");
        const value = displayCell(row, index);
        td.textContent = value;
        td.title = value === "—" ? "" : value;
        tr.appendChild(td);
      });
      if (state.model.totalMandayIndex < 0 || trade) {
        const td = document.createElement("td");
        td.textContent = formatNumber(rowMandays(row, trade));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });

    elements.tableCount.textContent = `${formatNumber(state.filteredRows.length, 0)} visible assignments`;
    elements.pageStatus.textContent = `Page ${state.page} of ${totalPages}`;
    elements.previousPage.disabled = state.page <= 1;
    elements.nextPage.disabled = state.page >= totalPages;
  }

  function renderChartEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "chart-empty";
    paragraph.textContent = message;
    container.appendChild(paragraph);
  }

  function clearFilters() {
    elements.searchInput.value = "";
    elements.activityFilter.value = "";
    elements.locationFilter.value = "";
    elements.tradeFilter.value = "";
    state.page = 1;
    applyFilters();
  }

  function initialise() {
    document.title = config.title || "Mandays & Assigned Activities";
    elements.title.textContent = config.title || "Mandays & Assigned Activities";
    elements.refreshButton.addEventListener("click", loadSheet);
    elements.retryButton.addEventListener("click", loadSheet);
    elements.searchInput.addEventListener("input", () => {
      state.page = 1;
      applyFilters();
    });
    [elements.activityFilter, elements.locationFilter, elements.tradeFilter].forEach((select) => {
      select.addEventListener("change", () => {
        state.page = 1;
        applyFilters();
      });
    });
    elements.clearFilters.addEventListener("click", clearFilters);
    elements.previousPage.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        renderTable();
      }
    });
    elements.nextPage.addEventListener("click", () => {
      if (state.page < Math.ceil(state.filteredRows.length / PAGE_SIZE)) {
        state.page += 1;
        renderTable();
      }
    });

    loadSheet();
    const refreshMs = Number(config.refreshMinutes) * 60 * 1000;
    if (Number.isFinite(refreshMs) && refreshMs >= 60000) {
      window.setInterval(() => {
        if (!document.hidden) loadSheet();
      }, refreshMs);
    }
  }

  initialise();
})();
