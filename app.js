"use strict";

const isLocalDashboard = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const agentBaseUrl = isLocalDashboard ? "" : "http://127.0.0.1:3000";

const RANGE_LABELS = {
  "1h": "1H",
  "6h": "6H",
  "24h": "24H",
  "7d": "7D",
};

const elements = {
  heading: document.querySelector(".dashboard h1"),
  subtitle: document.querySelector(".page-subtitle"),
  deviceSelect: document.querySelector(".device-select"),
  status: document.querySelector(".device-status"),
  statusText: document.querySelector(".device-status > span:nth-child(2)"),
  connectAgent: document.querySelector(".connect-agent"),
  cpuCard: document.querySelector(".metrics-grid .metric-card:nth-child(1)"),
  gpuCard: document.querySelector(".metrics-grid .metric-card:nth-child(2)"),
  memoryCard: document.querySelector(".memory-card"),
  chart: document.querySelector(".main-chart"),
  chartTooltip: document.querySelector(".chart-tooltip"),
  chartLabels: document.querySelector(".chart-x-labels"),
  rangeButtons: [...document.querySelectorAll(".range-switch button")],
  alerts: document.querySelector(".alerts-panel"),
  alertBadge: document.querySelector(".alert-count"),
  notificationDot: document.querySelector(".notification-dot"),
  notificationButton: document.querySelector(".topbar-bell"),
  themeToggle: document.querySelector(".theme-toggle"),
  navLinks: [...document.querySelectorAll(".side-nav .nav-item")],
  agentStatus: document.querySelector(".agent-card-top .agent-online"),
  agentDescription: document.querySelector(".agent-card p"),
  agentVersion: document.querySelector(".agent-version span"),
  processorDetails: document.querySelector(".system-details > div:nth-child(1) dd"),
  graphicsDetails: document.querySelector(".system-details > div:nth-child(2) dd"),
  operatingSystemDetails: document.querySelector(".system-details > div:nth-child(3) dd"),
  uptimeDetails: document.querySelector(".system-details > div:nth-child(4) dd"),
};

function setTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = theme;
  elements.themeToggle?.setAttribute("aria-pressed", String(isLight));
  elements.themeToggle?.setAttribute("title", `Switch to ${isLight ? "dark" : "light"} mode`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isLight ? "#f4f6fb" : "#0b1018");
}

function initializeTheme() {
  let theme = "dark";
  try {
    const savedTheme = localStorage.getItem("pulse-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      theme = savedTheme;
    }
  } catch (error) {
    console.error("Could not load the saved theme:", error);
  }
  setTheme(theme);
}

const state = {
  range: "6h",
  metrics: null,
  device: null,
  history: [],
  reconnectDelay: 1_000,
  source: null,
  activeAlertCount: 0,
  connected: false,
  agentAuthorized: false,
};

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatDuration(totalSeconds) {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatRelativeTime(timestamp) {
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1_000));
  if (elapsedSeconds < 5) {
    return "just now";
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} seconds ago`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  return `${Math.floor(minutes / 60)} hours ago`;
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function formatGraphicsSummary(graphics) {
  if (!Array.isArray(graphics) || graphics.length === 0) {
    return "GPU information unavailable";
  }
  return graphics
    .map((gpu) => `${gpu.name} (${gpu.isDedicated ? "Dedicated" : "Integrated"})`)
    .join(" · ");
}

function setErrorStatus(message) {
  state.connected = false;
  const statusText = elements.statusText;
  if (statusText) {
    statusText.textContent = message;
  }
  elements.status?.classList.add("status-offline");
  const live = document.querySelector(".status-live");
  if (live) {
    live.replaceChildren(document.createElement("span"), document.createTextNode(" OFFLINE"));
    live.classList.add("status-offline-live");
  }
  elements.agentStatus?.classList.add("agent-offline");
  setText(elements.agentStatus, "Offline");
  setText(elements.agentDescription, "Start the local monitor to connect.");
  document.body.classList.add("api-offline");
}

function setConnectedStatus(timestamp) {
  state.connected = true;
  const statusText = elements.statusText;
  if (statusText) {
    statusText.replaceChildren();
    const label = document.createElement("strong");
    label.textContent = state.activeAlertCount
      ? "Connected · attention needed"
      : "Connected and healthy";
    const separator = document.createElement("span");
    separator.className = "status-separator";
    separator.textContent = "·";
    statusText.append(label, separator, document.createTextNode(` Last updated ${formatRelativeTime(timestamp)}`));
  }
  elements.status?.classList.remove("status-offline");
  const live = document.querySelector(".status-live");
  if (live) {
    live.replaceChildren(document.createElement("span"), document.createTextNode(" LIVE"));
    live.classList.remove("status-offline-live");
  }
  elements.agentStatus?.classList.remove("agent-offline");
  elements.status?.querySelector(".connection-retry")?.remove();
  elements.agentStatus?.classList.toggle("agent-alert", state.activeAlertCount > 0);
  setText(elements.agentStatus, state.activeAlertCount ? "Alert" : "Online");
  setText(
    elements.agentDescription,
    state.activeAlertCount
      ? `${state.activeAlertCount} active system alert${state.activeAlertCount === 1 ? "" : "s"}.`
      : "All systems reporting normally.",
  );
  document.body.classList.remove("api-offline");
}

async function requestJson(url) {
  if (!isLocalDashboard && !state.agentAuthorized) {
    throw new Error("Connect to this PC before reading local metrics.");
  }
  const response = await fetch(`${agentBaseUrl}${url}`, { cache: "no-store" });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `Request failed with status ${response.status}.`);
  }
  return result;
}

function updateDevice(device, metrics) {
  state.device = device;
  const deviceName = device.hostname || device.id;
  elements.deviceSelect?.setAttribute("aria-label", `${deviceName}, this computer`);
  const deviceTitle = elements.deviceSelect?.querySelector(".device-select-copy strong");
  setText(deviceTitle, deviceName);
  setText(elements.heading, "System overview");
  if (elements.subtitle) {
    elements.subtitle.textContent = `A real-time pulse on ${deviceName}.`;
  }
  if (elements.processorDetails) {
    elements.processorDetails.textContent = device.processor || "Unknown processor";
    elements.processorDetails.title = device.processor || "";
  }
  if (elements.graphicsDetails) {
    elements.graphicsDetails.textContent = formatGraphicsSummary(device.graphics);
    elements.graphicsDetails.title = elements.graphicsDetails.textContent;
  }
  setText(
    elements.operatingSystemDetails,
    device.operatingSystem || device.platform || "Waiting for agent details",
  );
  if (elements.uptimeDetails && metrics) {
    elements.uptimeDetails.textContent = formatDuration(metrics.uptimeSeconds);
  }
}

function setMetricState(element, severity, label) {
  if (!element) {
    return;
  }
  element.classList.remove("state-normal", "state-warning", "state-critical", "state-unavailable");
  element.classList.add(`state-${severity}`);
  const dot = element.querySelector("i");
  if (dot) {
    dot.setAttribute("aria-hidden", "true");
  }
  const existingText = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (existingText) {
    existingText.textContent = ` ${label}`;
  } else {
    element.append(document.createTextNode(` ${label}`));
  }
}

function severityFor(percent, warning = 75, critical = 90) {
  if (!Number.isFinite(percent)) {
    return "unavailable";
  }
  if (percent >= critical) {
    return "critical";
  }
  return percent >= warning ? "warning" : "normal";
}

function updateMeter(card, percent, descriptor, statusText) {
  if (!card) {
    return;
  }
  const meter = card.querySelector(".meter");
  const value = card.querySelector(".meter-center strong");
  const stateLabel = card.querySelector(".metric-state");
  if (!Number.isFinite(percent)) {
    if (meter) {
      meter.setAttribute("aria-label", `${descriptor}: unavailable`);
      meter.style.setProperty("--meter-value", "0%");
    }
    if (value) {
      value.replaceChildren(document.createTextNode("—"));
    }
    setMetricState(stateLabel, "unavailable", statusText || "Unavailable");
    return;
  }

  const normalized = formatNumber(percent);
  if (meter) {
    meter.style.setProperty("--meter-value", `${Math.min(100, Math.max(0, percent))}%`);
    meter.setAttribute("aria-label", `${descriptor} ${normalized} percent`);
  }
  if (value) {
    value.replaceChildren(document.createTextNode(normalized));
    const suffix = document.createElement("span");
    suffix.textContent = "%";
    value.append(suffix);
  }
  setMetricState(stateLabel, severityFor(percent), statusText || severityFor(percent));
}

function updateCpu(metrics) {
  const cpu = metrics.cpu;
  updateMeter(
    elements.cpuCard,
    cpu.utilizationPercent,
    "CPU usage",
    "Normal",
  );
  const cpuSpeed = elements.cpuCard?.querySelector(".metric-detail > strong");
  if (cpuSpeed) {
    cpuSpeed.replaceChildren(
      document.createTextNode(
        Number.isFinite(cpu.speedMHz) ? formatNumber(cpu.speedMHz / 1_000, 2) : "—",
      ),
    );
    const unit = document.createElement("small");
    unit.textContent = "GHz";
    cpuSpeed.append(unit);
  }
  setText(
    elements.cpuCard?.querySelector(".metric-detail .detail-label"),
    "Current speed",
  );
  const footer = elements.cpuCard?.querySelectorAll(".metric-footer span");
  if (footer?.[0]) {
    footer[0].textContent = cpu.model || state.device?.processor || "Unknown processor";
    footer[0].title = footer[0].textContent;
  }
  setText(footer?.[1], `${cpu.logicalCores || state.device?.logicalCores || "—"} cores`);
}

function updateGpu(metrics) {
  const gpu = metrics.gpu;
  const matchingAdapter = state.device?.graphics?.find(
    (adapter) => adapter.name === gpu.name || adapter.luid === gpu.primaryAdapterLuid,
  );
  const isDedicated = gpu.isDedicated ?? matchingAdapter?.isDedicated;
  const gpuLabel = elements.gpuCard?.querySelector(".metric-label");
  let gpuTypeBadge = gpuLabel?.querySelector(".gpu-type-badge");
  if (gpuLabel && !gpuTypeBadge) {
    gpuTypeBadge = document.createElement("span");
    gpuTypeBadge.className = "gpu-type-badge";
    gpuLabel.append(gpuTypeBadge);
  }
  if (gpuTypeBadge) {
    gpuTypeBadge.hidden = typeof isDedicated !== "boolean";
    gpuTypeBadge.textContent = isDedicated ? "DEDICATED" : "INTEGRATED";
    gpuTypeBadge.classList.toggle("dedicated", isDedicated === true);
  }
  updateMeter(
    elements.gpuCard,
    gpu.utilizationPercent,
    "GPU usage",
    gpu.error ? "Unavailable" : "Normal",
  );
  const metricDetail = elements.gpuCard?.querySelector(".metric-detail");
  const value = metricDetail?.querySelector(":scope > strong");
  const label = metricDetail?.querySelector(":scope > .detail-label");
  if (value) {
    value.replaceChildren(
      document.createTextNode(Number.isFinite(gpu.temperatureC) ? formatNumber(gpu.temperatureC) : "—"),
    );
    const unit = document.createElement("small");
    unit.textContent = Number.isFinite(gpu.temperatureC) ? "°C" : "";
    value.append(unit);
  }
  setText(label, Number.isFinite(gpu.temperatureC) ? "Temperature" : "Temperature unavailable");

  const footer = elements.gpuCard?.querySelectorAll(".metric-footer span");
  if (footer?.[0]) {
    footer[0].textContent = gpu.name || "GPU telemetry unavailable";
    footer[0].title = gpu.error || gpu.name || "No GPU detected";
  }
  if (footer?.[1]) {
    footer[1].textContent = Number.isFinite(gpu.memoryTotalMB)
      ? `${formatNumber(gpu.memoryTotalMB / 1_024)} GB VRAM`
      : "VRAM unavailable";
  }
  if (gpu.error) {
    setMetricState(elements.gpuCard?.querySelector(".metric-state"), "unavailable", "Unavailable");
  }
}

function updateMemory(metrics) {
  const memory = metrics.memory;
  setText(
    elements.memoryCard?.querySelector(".memory-reading strong"),
    formatNumber(memory.usedGB, 2),
  );
  const readingUnit = elements.memoryCard?.querySelector(".memory-reading > span");
  if (readingUnit) {
    readingUnit.replaceChildren(
      document.createTextNode("GB "),
      Object.assign(document.createElement("i"), { textContent: "/" }),
      document.createTextNode(` ${formatNumber(memory.totalGB, 1)} GB`),
    );
  }
  const bar = elements.memoryCard?.querySelector(".memory-bar");
  const fill = bar?.querySelector("span");
  if (fill) {
    fill.style.width = `${Math.min(100, Math.max(0, memory.utilizationPercent))}%`;
  }
  bar?.setAttribute(
    "aria-label",
    `Memory usage ${formatNumber(memory.utilizationPercent)} percent`,
  );
  const metadata = elements.memoryCard?.querySelectorAll(".memory-meta span");
  setText(metadata?.[0], `${formatNumber(memory.utilizationPercent)}% utilized`);
  setText(
    metadata?.[1],
    `${formatNumber(memory.availableBytes / 1024 ** 3, 2)} GB available`,
  );
  setMetricState(
    elements.memoryCard?.querySelector(".metric-state"),
    severityFor(memory.utilizationPercent, 80),
    "Normal",
  );
  if (elements.uptimeDetails) {
    elements.uptimeDetails.textContent = formatDuration(metrics.uptimeSeconds);
  }
}

function updateChartHistory(points) {
  state.history = points;
  const availablePoints = points.filter((point) => Number.isFinite(point.cpu));
  if (availablePoints.length === 0 || !elements.chart) {
    if (elements.chartTooltip && availablePoints.length === 0) {
      elements.chartTooltip.hidden = true;
    }
    return;
  }
  const entries =
    availablePoints.length === 1
      ? [availablePoints[0], availablePoints[0]]
      : availablePoints;

  const width = 900;
  const height = 220;
  const xPosition = (index) => (index / (entries.length - 1)) * width;
  const yPosition = (value) => height - (Math.max(0, Math.min(100, value)) / 100) * height;
  const createLine = (field) => {
    let started = false;
    return entries
      .map((point, index) => {
        const value = point[field];
        if (!Number.isFinite(value)) {
          return "";
        }
        const command = started ? "L" : "M";
        started = true;
        return `${command}${xPosition(index).toFixed(1)} ${yPosition(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  };

  const cpuLine = createLine("cpu");
  const gpuLine = createLine("gpu");
  const memoryLine = createLine("memory");
  const cpuFirstPoint = entries.findIndex((point) => Number.isFinite(point.cpu));
  const cpuLastPoint = entries.findLastIndex((point) => Number.isFinite(point.cpu));
  const gpuFirstPoint = entries.findIndex((point) => Number.isFinite(point.gpu));
  const gpuLastPoint = entries.findLastIndex((point) => Number.isFinite(point.gpu));
  const cpuArea = `${cpuLine} L${xPosition(cpuLastPoint)} ${height} L${xPosition(cpuFirstPoint)} ${height} Z`;
  const gpuArea =
    gpuLine && gpuFirstPoint !== gpuLastPoint
      ? `${gpuLine} L${xPosition(gpuLastPoint)} ${height} L${xPosition(gpuFirstPoint)} ${height} Z`
      : "";

  elements.chart.querySelector(".chart-line-cpu")?.setAttribute("d", cpuLine);
  elements.chart.querySelector(".chart-area-cpu")?.setAttribute("d", cpuArea);
  elements.chart.querySelector(".chart-line-gpu")?.setAttribute("d", gpuLine);
  elements.chart.querySelector(".chart-area-gpu")?.setAttribute("d", gpuArea);
  elements.chart.querySelector(".chart-line-memory")?.setAttribute("d", memoryLine);
  const sparklinePoints = entries.map((point, index) => ({
    x: (index / (entries.length - 1)) * 120,
    y: 38 - (Math.max(0, Math.min(100, point.memory || 0)) / 100) * 36,
  }));
  const memoryPath = sparklinePoints
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(" ");
  elements.memoryCard?.querySelector(".memory-line")?.setAttribute("d", memoryPath);
  elements.memoryCard
    ?.querySelector(".memory-area")
    ?.setAttribute("d", `${memoryPath} L120 38 L0 38 Z`);
  for (const [card, field] of [
    [elements.cpuCard, "cpu"],
    [elements.gpuCard, "gpu"],
  ]) {
    const sparkline = card?.querySelector(".sparkline");
    let sparkStarted = false;
    const sparkPath = entries
      .map((point, index) => {
        const value = point[field];
        if (!Number.isFinite(value)) {
          return "";
        }
        const command = sparkStarted ? "L" : "M";
        sparkStarted = true;
        const x = (index / (entries.length - 1)) * 320;
        const y = 36 - (Math.max(0, Math.min(100, value)) / 100) * 32;
        return `${command}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
    const firstPoint = entries.findIndex((point) => Number.isFinite(point[field]));
    const lastPoint = entries.findLastIndex((point) => Number.isFinite(point[field]));
    sparkline?.querySelector(".spark-stroke")?.setAttribute("d", sparkPath);
    sparkline?.querySelector(".spark-fill")?.setAttribute(
      "d",
      sparkPath && firstPoint !== lastPoint
        ? `${sparkPath} L${(lastPoint / (entries.length - 1)) * 320} 38 L${(firstPoint / (entries.length - 1)) * 320} 38 Z`
        : "",
    );
  }

  const lastPoint = entries.at(-1);
  const lastX = xPosition(entries.length - 1);
  const lastY = yPosition(lastPoint.cpu);
  const cursor = elements.chart.querySelector(".chart-cursor");
  const crosshair = elements.chart.querySelector(".chart-crosshair");
  cursor?.setAttribute("cx", lastX);
  cursor?.setAttribute("cy", lastY);
  crosshair?.setAttribute("x1", lastX);
  crosshair?.setAttribute("x2", lastX);
  const tooltip = elements.chartTooltip;
  if (tooltip) {
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(1, Math.min(82, (lastX / width) * 100 + 1))}%`;
    tooltip.style.top = `${Math.max(3, Math.min(72, (lastY / height) * 100 - 12))}%`;
    setText(tooltip.querySelector(":scope > span"), formatTime(lastPoint.timestamp));
    const values = [lastPoint.cpu, lastPoint.gpu, lastPoint.memory];
    tooltip.querySelectorAll("strong b").forEach((value, index) => {
      value.textContent = Number.isFinite(values[index])
        ? `${formatNumber(values[index])}%`
        : "—";
    });
  }

  if (elements.chartLabels) {
    const labelCount = 7;
    const labels = Array.from({ length: labelCount }, (_, index) => {
      const pointIndex = Math.round((index / (labelCount - 1)) * (entries.length - 1));
      return pointIndex;
    });
    elements.chartLabels.replaceChildren(
      ...labels.map((pointIndex, index) => {
        const label = document.createElement("span");
        label.textContent = index === labelCount - 1 ? "NOW" : formatTime(entries[pointIndex].timestamp);
        return label;
      }),
    );
  }
}

function renderAlerts(alertList) {
  if (!elements.alerts) {
    return;
  }
  const existingRows = elements.alerts.querySelectorAll(".alert-row");
  existingRows.forEach((row) => row.remove());
  elements.alerts.querySelector(".alert-empty")?.remove();
  const heading = elements.alerts.querySelector(".compact-heading");
  const visibleAlerts = alertList.slice(0, 4);
  if (visibleAlerts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "alert-empty";
    empty.textContent = "No alerts yet. Threshold breaches will appear here.";
    heading?.after(empty);
    return;
  }
  let previousRow = heading;
  for (const alert of visibleAlerts) {
    const row = document.createElement("div");
    row.className = "alert-row";
    const symbol = document.createElement("span");
    symbol.className = `alert-symbol ${alert.resolvedAt ? "alert-resolved" : alert.severity === "critical" ? "alert-critical" : "alert-warning"}`;
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = alert.resolvedAt ? "✓" : alert.severity === "critical" ? "!" : "△";
    const copy = document.createElement("span");
    copy.className = "alert-copy";
    const title = document.createElement("strong");
    title.textContent = alert.resolvedAt ? `${alert.title} — resolved` : alert.title;
    const message = document.createElement("small");
    message.textContent = alert.message;
    copy.append(title, message);
    const time = document.createElement("span");
    time.className = "alert-time";
    time.textContent = formatRelativeTime(alert.resolvedAt || alert.timestamp);
    time.title = new Date(alert.timestamp).toLocaleString();
    row.append(symbol, copy, time);
    previousRow?.after(row);
    previousRow = row;
  }
}

function updateActiveAlertCount(count) {
  state.activeAlertCount = count;
  setText(elements.alertBadge, String(count));
  if (elements.alertBadge) {
    elements.alertBadge.hidden = count === 0;
  }
  if (elements.notificationDot) {
    elements.notificationDot.hidden = count === 0;
  }
  if (state.metrics && state.connected) {
    setConnectedStatus(state.metrics.timestamp);
  }
}

async function loadAlerts() {
  const result = await requestJson("/api/alerts?limit=20");
  renderAlerts(result.alerts);
  updateActiveAlertCount(result.activeCount);
}

async function loadHistory() {
  const result = await requestJson(`/api/history?range=${encodeURIComponent(state.range)}`);
  updateChartHistory(result.points);
}

function updateMetrics(metrics) {
  state.metrics = metrics;
  updateCpu(metrics);
  updateGpu(metrics);
  updateMemory(metrics);
  setConnectedStatus(metrics.timestamp);
  const latestHistoryPoint = {
    timestamp: metrics.timestamp,
    cpu: metrics.cpu.utilizationPercent,
    gpu: metrics.gpu.utilizationPercent,
    memory: metrics.memory.utilizationPercent,
  };
  const latest = state.history.at(-1);
  if (!latest || Date.parse(metrics.timestamp) - Date.parse(latest.timestamp) >= 9_000) {
    updateChartHistory([...state.history, latestHistoryPoint]);
  }
}

async function initializeDashboard() {
  const [device, metrics, alertResult, health] = await Promise.all([
    requestJson("/api/device"),
    requestJson("/api/metrics"),
    requestJson("/api/alerts?limit=20"),
    requestJson("/api/health"),
    loadHistory(),
  ]);
  updateDevice(device, metrics);
  updateMetrics(metrics);
  setText(elements.agentVersion, `v${health.version}`);
  renderAlerts(alertResult.alerts);
  updateActiveAlertCount(alertResult.activeCount);
}

function connectEvents() {
  if (!("EventSource" in window)) {
    setErrorStatus("Live monitoring requires EventSource support in this browser.");
    return;
  }
  state.source?.close();
  const source = new EventSource(`${agentBaseUrl}/api/events`);
  state.source = source;
  source.addEventListener("open", () => {
    state.reconnectDelay = 1_000;
    if (state.metrics) {
      setConnectedStatus(state.metrics.timestamp);
    }
  });
  source.addEventListener("metrics", (event) => {
    try {
      updateMetrics(JSON.parse(event.data));
    } catch (error) {
      console.error("Could not read live metrics:", error);
    }
  });
  source.addEventListener("alerts", (event) => {
    try {
      const alertList = JSON.parse(event.data);
      renderAlerts(alertList);
      updateActiveAlertCount(alertList.filter((alert) => !alert.resolvedAt).length);
    } catch (error) {
      console.error("Could not read live alerts:", error);
    }
  });
  source.addEventListener("alert", (event) => {
    try {
      const alert = JSON.parse(event.data);
      loadAlerts().catch((error) => console.error("Could not refresh alerts:", error));
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(alert.title, { body: alert.message, tag: alert.key });
      }
    } catch (error) {
      console.error("Could not read alert notification:", error);
    }
  });
  source.addEventListener("alert-resolved", () => {
    loadAlerts().catch((error) => console.error("Could not refresh alerts:", error));
  });
  source.onerror = () => {
    setErrorStatus("Connection interrupted. Reconnecting to the local monitor…");
    if (state.source?.readyState === EventSource.CLOSED) {
      state.source.close();
      const delay = state.reconnectDelay;
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15_000);
      window.setTimeout(connectEvents, delay);
    }
  };
}

function bindControls() {
  elements.themeToggle?.addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    setTheme(theme);
    try {
      localStorage.setItem("pulse-theme", theme);
    } catch (error) {
      console.error("Could not save the selected theme:", error);
    }
  });

  elements.rangeButtons.forEach((button) => {
    const range = button.textContent.trim().toLowerCase();
    button.setAttribute("aria-pressed", String(range === state.range));
    button.addEventListener("click", () => {
      if (!RANGE_LABELS[range]) {
        return;
      }
      state.range = range;
      elements.rangeButtons.forEach((item) => {
        const selected = item === button;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      loadHistory().catch((error) => console.error("Could not load chart history:", error));
    });
  });

  elements.notificationButton?.addEventListener("click", () => {
    elements.alerts?.scrollIntoView({ behavior: "smooth", block: "center" });
    elements.alerts?.classList.add("panel-highlight");
    window.setTimeout(() => elements.alerts?.classList.remove("panel-highlight"), 1_000);
  });

  const alertLink = [...document.querySelectorAll(".alerts-panel a")].find((link) =>
    link.textContent.includes("View all"),
  );
  alertLink?.addEventListener("click", (event) => {
    event.preventDefault();
    loadAlerts().catch((error) => console.error("Could not refresh alerts:", error));
    elements.alerts?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  elements.navLinks.forEach((link, index) => {
    const targets = ["#overview", "#device", "#alerts", "#performance"];
    link.href = targets[index] || "#overview";
    link.addEventListener("click", () => {
      elements.navLinks.forEach((item) => item.classList.toggle("active", item === link));
    });
  });
}

initializeTheme();
bindControls();
if (location.protocol === "file:") {
  setErrorStatus("This dashboard was opened as a file. Open the hosted HTTPS dashboard or use http://127.0.0.1:3000.");
  if (elements.connectAgent) {
    elements.connectAgent.hidden = true;
  }
} else if (isLocalDashboard) {
  initializeDashboard()
    .then(connectEvents)
    .catch((error) => {
      setErrorStatus(`Local monitor unavailable: ${error.message}`);
      console.error("Could not connect to the local monitor:", error);
      const retryButton = document.createElement("button");
      retryButton.className = "connection-retry";
      retryButton.type = "button";
      retryButton.textContent = "Retry connection";
      retryButton.addEventListener("click", () => window.location.reload());
      elements.status?.append(retryButton);
    });
} else {
  setErrorStatus("Install and start the Windows agent, then connect. Metrics stay on this PC.");
  elements.connectAgent.hidden = false;
  elements.connectAgent.addEventListener("click", async () => {
    if (state.agentAuthorized) {
      state.source?.close();
      state.agentAuthorized = false;
      window.location.reload();
      return;
    }
    elements.connectAgent.disabled = true;
    elements.connectAgent.textContent = "Connecting…";
    state.agentAuthorized = true;
    try {
      await initializeDashboard();
      connectEvents();
    } catch (error) {
      state.agentAuthorized = false;
      console.error("Could not connect to the local monitor:", error);
      const message = error.message.includes("Requests must come from this local dashboard")
        ? "Pulse rejected this website. Restart the agent and configure the exact HTTPS dashboard address in the installer."
        : error instanceof TypeError
          ? "The browser could not reach Pulse. Make sure it is running and allow local-network access if prompted."
          : `Could not connect: ${error.message}`;
      setErrorStatus(message);
    } finally {
      elements.connectAgent.disabled = false;
      elements.connectAgent.textContent = state.agentAuthorized ? "Disconnect" : "Connect to this PC";
    }
  });
}

window.setInterval(() => {
  if (state.metrics && state.connected) {
    const age = Date.now() - Date.parse(state.metrics.timestamp);
    if (age > 8_000) {
      setErrorStatus("System metrics have gone stale. Reconnecting…");
    } else {
      setConnectedStatus(state.metrics.timestamp);
    }
  }
}, 5_000);

window.addEventListener("beforeunload", () => state.source?.close(), { once: true });
