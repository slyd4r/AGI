(function () {
  "use strict";

  const config = window.DASHBOARD_CONFIG || {};
  const PAGE_SIZE = 12;
  const CHART_COLORS = ["#0f8f83", "#2f6fed", "#f58a07", "#d84a4a", "#7b61c9", "#5b7083"];

  const state = {
    columns: [],
    rows: [],
    filteredRows: [],
    model: {},
    page: 1,
    loadingScript: null,
    timeoutId: null,
  };

  const elements = {
    title: document.getElementById("dashboard-title"),
    sourceLink: document.getElementById("source-link"),
    syncStatus: document.getElementById("sync-status"),
    syncDot: document.querySelector(".sync-dot"),
    refreshButton: document.getElementById("refresh-button"),
    searchInput: document.getElementById("search-input"),
    categoryWrap: document.getElementById("category-filter-wrap"),
    categoryLabel: document.getElementById("category-filter-label"),
    categoryFilter: document.getElementById("category-filter"),
    statusWrap: document.getElementById("status-filter-wrap"),
    statusFilter: document.getElementById("status-filter"),
    clearFilters: document.getElementById("clear-filters"),
    recordSummary: document.getElementById("record-summary"),
    errorPanel: document.getElementById("error-panel"),
    errorMessage: document.getElementById("error-message"),
    retryButton: document.getElementById("retry-button"),
    kpiGrid: document.getElementById("kpi-grid"),
    chartGrid: document.getElementById("chart-grid"),
    statusChartTitle: document.getElementById("status-chart-title"),
    statusChart: document.getElementById("status-chart"),
    categoryChartTitle: document.getElementById("category-chart-title"),
    categoryChart: document.getElementById("category-chart"),
    trendPanel: document.getElementById("trend-panel"),
    trendTitle: document.getElementById("trend-chart-title"),
    trendCaption: document.getElementById("trend-caption"),
    trendChart: document.getElementById("trend-chart"),
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

  function displayLabel(column, index) {
    const label = String(column.label || "").trim();
    return label || `Column ${index + 1}`;
  }

  function formattedCell(row, index) {
    const cell = row.cells[index];
    if (!cell || cell.value === null || cell.value === undefined || cell.value === "") return "—";
    if (cell.formatted !== null && cell.formatted !== undefined && cell.formatted !== "") {
      return String(cell.formatted);
    }
    if (cell.value instanceof Date) return formatDate(cell.value, true);
    if (typeof cell.value === "number") return formatNumber(cell.value);
    if (typeof cell.value === "boolean") return cell.value ? "Yes" : "No";
    return String(cell.value);
  }

  function rawCell(row, index) {
    if (index === null || index === undefined || index < 0) return null;
    return row.cells[index] ? row.cells[index].value : null;
  }

  function formatNumber(value, maximumFractionDigits = 1) {
    return new Intl.NumberFormat(config.locale || "en-GB", { maximumFractionDigits }).format(value);
  }

  function formatDate(value, includeYear) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return String(value || "—");
    return new Intl.DateTimeFormat(config.locale || "en-GB", {
      day: "2-digit",
      month: "short",
      year: includeYear ? "numeric" : undefined,
      timeZone: config.timeZone || undefined,
    }).format(date);
  }

  function parseDate(value) {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
    if (typeof value === "number" && value > 20000 && value < 100000) {
      return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const match = value.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (match) {
      return new Date(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4] || 0),
        Number(match[5] || 0),
        Number(match[6] || 0),
      );
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  function numberValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/,/g, "").replace(/%/g, "").trim();
    if (!cleaned) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }

  function findColumn(tokens, options = {}) {
    const exactTokens = tokens.map(normaliseLabel);
    let result = -1;
    let bestScore = 0;

    state.columns.forEach((column, index) => {
      if (options.type && column.type !== options.type) return;
      const label = normaliseLabel(column.label);
      if (!label) return;
      let score = 0;
      exactTokens.forEach((token) => {
        if (label === token) score = Math.max(score, 100 + token.length);
        else if (label.startsWith(`${token} `) || label.endsWith(` ${token}`)) {
          score = Math.max(score, 70 + token.length);
        } else if (label.includes(token)) score = Math.max(score, 40 + token.length);
      });
      if (score > bestScore) {
        bestScore = score;
        result = index;
      }
    });
    return result;
  }

  function firstTextColumn(excluded) {
    return state.columns.findIndex(
      (column, index) => column.type === "string" && !excluded.includes(index),
    );
  }

  function detectModel() {
    const dateIndex = (() => {
      const labelled = findColumn(["update date", "record date", "date", "updated", "timestamp"]);
      if (labelled >= 0) return labelled;
      return state.columns.findIndex((column) => ["date", "datetime"].includes(column.type));
    })();

    const statusIndex = findColumn(["progress status", "task status", "status", "state"]);
    const progressIndex = findColumn([
      "progress %",
      "progress",
      "completion %",
      "percent complete",
      "% complete",
      "actual %",
    ]);
    const actualIndex = findColumn(["actual quantity", "actual", "completed quantity", "done"]);
    const totalIndex = findColumn(["total quantity", "total", "budget quantity", "planned quantity"]);
    const remainingIndex = findColumn(["remaining quantity", "remaining", "balance"]);

    const categoryPriority = [
      "cluster",
      "area",
      "package",
      "section",
      "category",
      "project",
      "activity",
      "villa",
      "discipline",
      "type",
    ];
    let categoryIndex = findColumn(categoryPriority);
    if (categoryIndex < 0) categoryIndex = firstTextColumn([statusIndex, dateIndex]);

    let identityIndex = findColumn(["villa", "activity", "task", "item", "name", "id", "reference"]);
    if (identityIndex < 0) identityIndex = firstTextColumn([statusIndex, dateIndex, categoryIndex]);

    return {
      dateIndex,
      statusIndex,
      progressIndex,
      actualIndex,
      totalIndex,
      remainingIndex,
      categoryIndex,
      identityIndex,
    };
  }

  function normaliseStatus(value) {
    const raw = String(value || "").trim();
    if (!raw) return "Not specified";
    const status = normaliseLabel(raw);
    if (/complete|completed|done|finished|closed|approved/.test(status)) return "Complete";
    if (/delay|delayed|overdue|late/.test(status)) return "Delayed";
    if (/hold|blocked|suspend/.test(status)) return "On hold";
    if (/progress|ongoing|started|active|working/.test(status)) return "In progress";
    if (/not started|pending|planned|open|todo/.test(status)) return "Not started";
    return raw.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function rowProgress(row) {
    const { progressIndex, actualIndex, totalIndex, statusIndex } = state.model;
    if (progressIndex >= 0) {
      const raw = numberValue(rawCell(row, progressIndex));
      if (raw !== null) return Math.max(0, Math.min(100, raw <= 1.00001 ? raw * 100 : raw));
    }
    if (actualIndex >= 0 && totalIndex >= 0) {
      const actual = numberValue(rawCell(row, actualIndex));
      const total = numberValue(rawCell(row, totalIndex));
      if (actual !== null && total !== null && total > 0) {
        return Math.max(0, Math.min(100, (actual / total) * 100));
      }
    }
    if (statusIndex >= 0) {
      const status = normaliseStatus(rawCell(row, statusIndex));
      if (status === "Complete") return 100;
      if (status === "In progress") return 50;
      return 0;
    }
    return null;
  }

  function rowStatus(row) {
    if (state.model.statusIndex >= 0) {
      return normaliseStatus(rawCell(row, state.model.statusIndex));
    }
    const progress = rowProgress(row);
    if (progress === null) return "Recorded";
    if (progress >= 99.5) return "Complete";
    if (progress > 0) return "In progress";
    return "Not started";
  }

  function countBy(rows, valueForRow) {
    const counts = new Map();
    rows.forEach((row) => {
      const value = String(valueForRow(row) || "Not specified").trim() || "Not specified";
      counts.set(value, (counts.get(value) || 0) + 1);
    });
    return [...counts.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }

  function setLoading(isLoading) {
    elements.refreshButton.disabled = isLoading;
    elements.refreshButton.classList.toggle("is-loading", isLoading);
    if (isLoading) {
      elements.syncStatus.textContent = "Connecting to Google Sheets…";
      elements.syncDot.classList.remove("is-live", "is-error");
    }
  }

  function clearDataScript() {
    if (state.timeoutId) window.clearTimeout(state.timeoutId);
    state.timeoutId = null;
    if (state.loadingScript) state.loadingScript.remove();
    state.loadingScript = null;
  }

  function loadSheet() {
    clearDataScript();
    setLoading(true);
    elements.errorPanel.hidden = true;

    if (!config.spreadsheetId) {
      showError("The spreadsheet ID is missing from the dashboard configuration.");
      return;
    }

    const callbackName = `__sheetDashboardResponse_${Date.now()}`;
    window[callbackName] = function (response) {
      delete window[callbackName];
      clearDataScript();
      handleSheetResponse(response);
    };

    const params = new URLSearchParams();
    if (config.sheetName) params.set("sheet", config.sheetName);
    else params.set("gid", String(config.gid ?? "0"));
    params.set("headers", String(config.headers ?? 1));
    params.set("tq", "select *");
    params.set(
      "tqx",
      `out:json;responseHandler:${callbackName};reqId:${Date.now()}`,
    );

    const script = document.createElement("script");
    script.src = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
      config.spreadsheetId,
    )}/gviz/tq?${params.toString()}`;
    script.async = true;
    script.onerror = function () {
      delete window[callbackName];
      clearDataScript();
      showError(
        "The sheet did not respond. Confirm that General access is set to “Anyone with the link” with the Viewer role.",
      );
    };
    state.loadingScript = script;
    document.head.appendChild(script);

    state.timeoutId = window.setTimeout(() => {
      delete window[callbackName];
      clearDataScript();
      showError("The connection timed out. Check the sheet sharing settings, then try again.");
    }, 18000);
  }

  function handleSheetResponse(response) {
    if (!response || response.status === "error" || !response.table) {
      const details = response?.errors?.map((error) => error.message).filter(Boolean).join(" ");
      showError(details || "Google did not return readable sheet data.");
      return;
    }

    state.columns = (response.table.cols || []).map((column, index) => ({
      ...column,
      label: displayLabel(column, index),
    }));
    state.rows = (response.table.rows || [])
      .map((row, rowIndex) => ({
        id: rowIndex,
        cells: state.columns.map((_, columnIndex) => {
          const cell = row.c?.[columnIndex] || null;
          return {
            value: cell?.v ?? null,
            formatted: cell?.f ?? null,
          };
        }),
      }))
      .filter((row) => row.cells.some((cell) => cell.value !== null && cell.value !== ""));

    state.model = detectModel();
    state.page = 1;
    populateFilters();
    applyFilters();
    setLoading(false);
    elements.errorPanel.hidden = true;
    elements.syncDot.classList.add("is-live");
    elements.syncDot.classList.remove("is-error");
    elements.syncStatus.textContent = `Updated ${new Intl.DateTimeFormat(config.locale || "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: config.timeZone || undefined,
    }).format(new Date())}`;
  }

  function showError(message) {
    setLoading(false);
    elements.errorMessage.textContent = message;
    elements.errorPanel.hidden = false;
    elements.chartGrid.hidden = true;
    elements.tablePanel.hidden = true;
    elements.emptyPanel.hidden = true;
    elements.syncDot.classList.remove("is-live");
    elements.syncDot.classList.add("is-error");
    elements.syncStatus.textContent = "Sheet connection unavailable";
    elements.recordSummary.textContent = "No data loaded";
    renderKpis([
      { label: "Records", value: "—", note: "Waiting for sheet access", color: "#f58a07" },
      { label: "Columns", value: "—", note: "Waiting for sheet access", color: "#2f6fed" },
      { label: "Progress", value: "—", note: "Waiting for sheet access", color: "#0f8f83" },
      { label: "Latest update", value: "—", note: "Waiting for sheet access", color: "#7b61c9" },
    ]);
  }

  function populateSelect(select, values, allLabel) {
    const previous = select.value;
    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    select.appendChild(all);
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    select.value = values.includes(previous) ? previous : "";
  }

  function populateFilters() {
    const { categoryIndex, statusIndex, progressIndex } = state.model;

    if (categoryIndex >= 0) {
      const values = [
        ...new Set(
          state.rows
            .map((row) => formattedCell(row, categoryIndex))
            .filter((value) => value && value !== "—"),
        ),
      ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const label = state.columns[categoryIndex].label;
      elements.categoryLabel.textContent = label;
      populateSelect(elements.categoryFilter, values, `All ${label.toLowerCase()}`);
      elements.categoryWrap.hidden = values.length < 2;
    } else {
      elements.categoryWrap.hidden = true;
    }

    if (statusIndex >= 0 || progressIndex >= 0) {
      const statuses = [...new Set(state.rows.map(rowStatus))].sort();
      populateSelect(elements.statusFilter, statuses, "All statuses");
      elements.statusWrap.hidden = statuses.length < 2;
    } else {
      elements.statusWrap.hidden = true;
    }
  }

  function applyFilters() {
    const query = elements.searchInput.value.trim().toLowerCase();
    const selectedCategory = elements.categoryFilter.value;
    const selectedStatus = elements.statusFilter.value;
    const { categoryIndex } = state.model;

    state.filteredRows = state.rows.filter((row) => {
      if (
        selectedCategory &&
        categoryIndex >= 0 &&
        formattedCell(row, categoryIndex) !== selectedCategory
      ) {
        return false;
      }
      if (selectedStatus && rowStatus(row) !== selectedStatus) return false;
      if (query) {
        const haystack = row.cells
          .map((_, index) => formattedCell(row, index))
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    elements.clearFilters.hidden = !(query || selectedCategory || selectedStatus);
    elements.recordSummary.textContent =
      state.filteredRows.length === state.rows.length
        ? `${formatNumber(state.rows.length, 0)} records loaded from ${formatNumber(state.columns.length, 0)} columns`
        : `${formatNumber(state.filteredRows.length, 0)} of ${formatNumber(state.rows.length, 0)} records shown`;

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
    renderStatusChart();
    renderCategoryChart();
    renderTrendChart();
    renderTable();
  }

  function renderKpiSummary() {
    const rows = state.filteredRows;
    const progressValues = rows.map(rowProgress).filter((value) => value !== null);
    const averageProgress = progressValues.length
      ? progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length
      : null;
    const statuses = rows.map(rowStatus);
    const completed = statuses.filter((status) => status === "Complete").length;
    const dates = rows
      .map((row) => parseDate(rawCell(row, state.model.dateIndex)))
      .filter(Boolean)
      .sort((a, b) => b - a);

    const secondMetric =
      state.model.statusIndex >= 0 || progressValues.length
        ? {
            label: "Complete",
            value: formatNumber(completed, 0),
            note: rows.length ? `${formatNumber((completed / rows.length) * 100)}% of visible records` : "No records",
            color: "#0f8f83",
          }
        : {
            label: "Columns",
            value: formatNumber(state.columns.length, 0),
            note: "Fields available in the sheet",
            color: "#2f6fed",
          };

    const thirdMetric =
      averageProgress !== null
        ? {
            label: "Average progress",
            value: `${formatNumber(averageProgress)}%`,
            note: "Across visible records",
            color: "#2f6fed",
          }
        : numericMetric(rows);

    renderKpis([
      {
        label: "Records",
        value: formatNumber(rows.length, 0),
        note: rows.length === state.rows.length ? "All sheet records" : `Filtered from ${formatNumber(state.rows.length, 0)}`,
        color: "#f58a07",
      },
      secondMetric,
      thirdMetric,
      {
        label: dates.length ? "Latest update" : "Data source",
        value: dates.length ? formatDate(dates[0], true) : "Live",
        note: dates.length ? "Most recent visible date" : "Connected to Google Sheets",
        color: "#7b61c9",
      },
    ]);
  }

  function numericMetric(rows) {
    const numericIndex = state.columns.findIndex((column) => column.type === "number");
    if (numericIndex < 0) {
      return {
        label: "Visible fields",
        value: formatNumber(state.columns.length, 0),
        note: "Columns in the source sheet",
        color: "#2f6fed",
      };
    }
    const values = rows.map((row) => numberValue(rawCell(row, numericIndex))).filter((value) => value !== null);
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      label: state.columns[numericIndex].label,
      value: formatNumber(sum),
      note: "Total across visible records",
      color: "#2f6fed",
    };
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

  function renderStatusChart() {
    const counts = countBy(state.filteredRows, rowStatus).slice(0, 6);
    const total = counts.reduce((sum, item) => sum + item.value, 0);
    elements.statusChart.replaceChildren();
    elements.statusChartTitle.textContent = state.model.statusIndex >= 0 ? "Status overview" : "Progress stages";

    if (!total) {
      renderChartEmpty(elements.statusChart, "No status values to chart.");
      return;
    }

    let current = 0;
    const stops = counts.map((item, index) => {
      const start = (current / total) * 100;
      current += item.value;
      const end = (current / total) * 100;
      return `${CHART_COLORS[index]} ${start}% ${end}%`;
    });

    const donut = document.createElement("div");
    donut.className = "donut";
    donut.style.setProperty("--donut-stops", stops.join(", "));
    donut.setAttribute("role", "img");
    donut.setAttribute(
      "aria-label",
      counts.map((item) => `${item.label}: ${item.value}`).join(", "),
    );
    const center = document.createElement("div");
    center.className = "donut-center";
    const totalText = document.createElement("strong");
    totalText.textContent = formatNumber(total, 0);
    const totalLabel = document.createElement("span");
    totalLabel.textContent = "records";
    center.append(totalText, totalLabel);
    donut.appendChild(center);

    const legend = document.createElement("ul");
    legend.className = "legend";
    counts.forEach((item, index) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "legend-dot";
      dot.style.setProperty("--legend-color", CHART_COLORS[index]);
      const label = document.createElement("span");
      label.className = "legend-name";
      label.textContent = item.label;
      const value = document.createElement("span");
      value.className = "legend-value";
      value.textContent = `${formatNumber(item.value, 0)} · ${formatNumber((item.value / total) * 100)}%`;
      li.append(dot, label, value);
      legend.appendChild(li);
    });

    elements.statusChart.append(donut, legend);
  }

  function renderCategoryChart() {
    const categoryIndex = state.model.categoryIndex;
    elements.categoryChart.replaceChildren();
    if (categoryIndex < 0) {
      elements.categoryChartTitle.textContent = "Records by category";
      renderChartEmpty(elements.categoryChart, "Add a text category column to see this breakdown.");
      return;
    }

    const columnLabel = state.columns[categoryIndex].label;
    const counts = countBy(state.filteredRows, (row) => formattedCell(row, categoryIndex)).slice(0, 8);
    const maximum = Math.max(...counts.map((item) => item.value), 1);
    elements.categoryChartTitle.textContent = `Records by ${columnLabel}`;

    counts.forEach((item, index) => {
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
      value.textContent = formatNumber(item.value, 0);
      row.append(label, track, value);
      elements.categoryChart.appendChild(row);
    });
  }

  function renderTrendChart() {
    const dateIndex = state.model.dateIndex;
    if (dateIndex < 0) {
      elements.trendPanel.hidden = true;
      return;
    }

    const datedRows = state.filteredRows
      .map((row) => ({ row, date: parseDate(rawCell(row, dateIndex)) }))
      .filter((item) => item.date);
    if (datedRows.length < 2) {
      elements.trendPanel.hidden = true;
      return;
    }

    const hasProgress = datedRows.some((item) => rowProgress(item.row) !== null);
    const groups = new Map();
    datedRows.forEach((item) => {
      const key = `${item.date.getFullYear()}-${String(item.date.getMonth() + 1).padStart(2, "0")}-${String(
        item.date.getDate(),
      ).padStart(2, "0")}`;
      if (!groups.has(key)) groups.set(key, { date: item.date, count: 0, progress: [] });
      const group = groups.get(key);
      group.count += 1;
      const progress = rowProgress(item.row);
      if (progress !== null) group.progress.push(progress);
    });

    const points = [...groups.values()]
      .sort((a, b) => a.date - b.date)
      .slice(-14)
      .map((group) => ({
        date: group.date,
        value:
          hasProgress && group.progress.length
            ? group.progress.reduce((sum, value) => sum + value, 0) / group.progress.length
            : group.count,
      }));

    if (points.length < 2) {
      elements.trendPanel.hidden = true;
      return;
    }

    elements.trendPanel.hidden = false;
    elements.trendTitle.textContent = hasProgress ? "Average progress by date" : "Records by date";
    elements.trendCaption.textContent = `Latest ${points.length} dates`;
    elements.trendChart.replaceChildren();
    const bars = document.createElement("div");
    bars.className = "trend-bars";
    const maximum = hasProgress ? 100 : Math.max(...points.map((point) => point.value), 1);

    points.forEach((point, index) => {
      const item = document.createElement("div");
      item.className = "trend-item";
      item.title = `${formatDate(point.date, true)}: ${formatNumber(point.value)}${hasProgress ? "%" : " records"}`;
      const column = document.createElement("span");
      column.className = "trend-column";
      column.style.height = `${Math.max(2, (point.value / maximum) * 100)}%`;
      column.style.animationDelay = `${index * 30}ms`;
      const label = document.createElement("span");
      label.className = "trend-label";
      label.textContent = formatDate(point.date, false);
      item.append(column, label);
      bars.appendChild(item);
    });
    elements.trendChart.appendChild(bars);
  }

  function statusStyle(status) {
    const key = normaliseLabel(status);
    if (key === "complete") return { color: "#087468", background: "#def5f0" };
    if (key === "in progress") return { color: "#235fc4", background: "#e5efff" };
    if (key === "delayed") return { color: "#b43232", background: "#ffe8e8" };
    if (key === "on hold") return { color: "#9c5a00", background: "#fff0d6" };
    return { color: "#536b7e", background: "#edf2f6" };
  }

  function renderTable() {
    const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = state.filteredRows.slice(start, start + PAGE_SIZE);
    const visibleColumnIndexes = state.columns.map((_, index) => index).slice(0, 12);

    const thead = elements.table.querySelector("thead");
    const tbody = elements.table.querySelector("tbody");
    thead.replaceChildren();
    tbody.replaceChildren();

    const headerRow = document.createElement("tr");
    visibleColumnIndexes.forEach((columnIndex) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = state.columns[columnIndex].label;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

    pageRows.forEach((row) => {
      const tr = document.createElement("tr");
      visibleColumnIndexes.forEach((columnIndex) => {
        const td = document.createElement("td");
        const value = formattedCell(row, columnIndex);
        td.title = value === "—" ? "" : value;
        if (columnIndex === state.model.statusIndex) {
          const status = rowStatus(row);
          const style = statusStyle(status);
          const pill = document.createElement("span");
          pill.className = "status-pill";
          pill.textContent = status;
          pill.style.setProperty("--pill-color", style.color);
          pill.style.setProperty("--pill-bg", style.background);
          td.appendChild(pill);
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    elements.tableCount.textContent = `${formatNumber(state.filteredRows.length, 0)} visible records`;
    elements.pageStatus.textContent = `Page ${state.page} of ${totalPages}`;
    elements.previousPage.disabled = state.page <= 1;
    elements.nextPage.disabled = state.page >= totalPages;
  }

  function renderChartEmpty(container, message) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = message;
    container.appendChild(empty);
  }

  function clearFilters() {
    elements.searchInput.value = "";
    elements.categoryFilter.value = "";
    elements.statusFilter.value = "";
    state.page = 1;
    applyFilters();
  }

  function initialise() {
    document.title = config.title || "Project Progress Dashboard";
    elements.title.textContent = config.title || "Project Progress Dashboard";
    elements.sourceLink.href = config.sourceUrl || `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`;

    elements.refreshButton.addEventListener("click", loadSheet);
    elements.retryButton.addEventListener("click", loadSheet);
    elements.searchInput.addEventListener("input", () => {
      state.page = 1;
      applyFilters();
    });
    elements.categoryFilter.addEventListener("change", () => {
      state.page = 1;
      applyFilters();
    });
    elements.statusFilter.addEventListener("change", () => {
      state.page = 1;
      applyFilters();
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
      window.setInterval(loadSheet, refreshMs);
    }
  }

  initialise();
})();
