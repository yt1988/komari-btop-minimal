import { formatBytes, formatLoss, formatPercent, formatSpeed, lossTone, metricTone, networkTone } from '../format';
import type { HistoryMetric, LatencyQuery, NodeState } from '../domain';
import { LATENCY_RANGES, latencySeriesColor, latencyStats } from '../latency';
import type { LatencyColorAssignment } from '../latencyColors';
import { normalizeRegionCode, regionFlagUrl } from '../region';
import { createTrafficCell } from './traffic';
import { createMetricMenu } from './metricMenu';
import { renderLatencyChart, setChartOffline } from './chart';
import { renderStatusButton, renderStatusPanel, type StatusView } from './status';

export type DetailHandlers = {
  onBack: () => void;
  onRangeChange: (hours: number) => void;
  onHistoryRetry: () => void;
  onMetricChange: (metric: HistoryMetric) => void;
  onTaskToggle: (taskId: string) => void;
};

export type DetailOptions = {
  node: NodeState | null;
  status: StatusView;
  targets: ReadonlyMap<string, string>;
  metric: HistoryMetric;
  probeIntervals: ReadonlyMap<string, number>;
  history: LatencyQuery | null;
  historyState: 'loading' | 'ready' | 'error';
  historyRange: number;
  displayedHistoryRange: number | null;
  visibleTaskIds: string[];
  colorAssignments: LatencyColorAssignment;
  overflowTaskIds: string[];
  handlers: DetailHandlers;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

/**
 * The node name doubles as the node switcher's trigger (the app handles its
 * clicks by delegation). It is rebuilt only when the node changes, so live
 * updates keep its focus.
 */
function updateDetailName(container: HTMLElement, node: NodeState | null): void {
  const key = node ? `${node.metadata.uuid}|${node.metadata.region}|${node.metadata.name}` : '';
  if (container.dataset.key === key) {
    return;
  }
  container.dataset.key = key;
  if (!node) {
    container.replaceChildren();
    return;
  }
  const button = element('button', 'detail-switch');
  button.type = 'button';
  button.dataset.role = 'node-switch';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const code = normalizeRegionCode(node.metadata.region);
  if (code) {
    const region = element('img', 'detail-flag');
    region.src = regionFlagUrl(code);
    region.alt = `${code} flag`;
    region.title = code;
    region.addEventListener('error', () => {
      if (region.dataset.fallback === 'true') {
        return;
      }
      region.dataset.fallback = 'true';
      region.src = regionFlagUrl('');
    });
    button.append(region);
  }
  const name = element('span', 'detail-name-text');
  name.textContent = node.metadata.name;
  const caret = element('span', 'detail-switch-caret');
  caret.textContent = '▾';
  caret.setAttribute('aria-hidden', 'true');
  button.append(name, caret);
  container.replaceChildren(button);
}

function createMetricRow() {
  const row = element('div', 'metric-row');
  const cpu = element('div', 'metric metric-cpu');
  cpu.dataset.mobileLabel = 'CPU';

  const memory = element('div', 'metric metric-mem');
  memory.dataset.mobileLabel = 'MEM';
  const disk = element('div', 'metric metric-disk');
  disk.dataset.mobileLabel = 'DISK';
  const network = element('div', 'metric metric-network');
  network.dataset.mobileLabel = 'NETWORK';
  const directions = (['down', 'up'] as const).map((direction) => {
    const item = element('span', 'direction');
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    item.append(arrow, text);
    network.append(item);
    return { direction, item, text };
  });
  const traffic = createTrafficCell('metric metric-traffic traffic');
  row.append(cpu, memory, disk, network, traffic.cell);

  return {
    row,
    update(node: NodeState): void {
      const report = node.report;
      const tone = (value: boolean, warning = false) => !node.online ? 'danger' : !value ? 'muted' : warning ? 'warn' : 'ok';
      cpu.className = `metric metric-cpu ${tone(report?.cpuUsage != null, metricTone(report?.cpuUsage) === 'warning')}`;
      cpu.textContent = formatPercent(report?.cpuUsage);
      memory.className = `metric metric-mem ${tone(!!report?.ram)}`;
      memory.textContent = report?.ram ? `${formatBytes(report.ram.used)} / ${formatBytes(report.ram.total)}` : '--';
      disk.className = `metric metric-disk ${tone(!!report?.disk)}`;
      disk.textContent = report?.disk ? `${formatBytes(report.disk.used)} / ${formatBytes(report.disk.total)}` : '--';
      for (const { direction, item, text } of directions) {
        const value = report?.network?.[direction];
        item.className = `direction ${tone(value != null, networkTone(value) === 'warning')}`;
        text.textContent = formatSpeed(value);
      }
      traffic.update(node);
    },
  };
}

const metricRows = new WeakMap<HTMLElement, ReturnType<typeof createMetricRow>>();

function renderCore(container: HTMLElement, node: NodeState | null, view: StatusView, handlers: DetailHandlers): void {
  const control = element('div', 'detail-control');
  const back = element('button', 'back');
  back.type = 'button';
  back.textContent = '← node list';
  back.addEventListener('click', handlers.onBack);
  const status = element('button');
  status.type = 'button';
  status.dataset.role = 'status';
  status.setAttribute('aria-describedby', 'status-history');
  renderStatusButton(status, node, view);
  const panel = element('div', 'status-panel');
  panel.id = 'status-history';
  panel.dataset.role = 'status-panel';
  panel.setAttribute('aria-label', 'status history');
  renderStatusPanel(panel, view);
  control.append(back, status, panel);

  const title = element('h1', 'detail-name');
  title.dataset.role = 'name';
  updateDetailName(title, node);

  const table = element('div', 'metric-table');
  const heading = element('div', 'metric-head');
  ['CPU', 'MEM', 'DISK', 'NETWORK', 'TRAFFIC'].forEach((label) => {
    const cell = element('div');
    cell.textContent = label;
    heading.append(cell);
  });
  const rowContainer = element('div', 'metric-row-container');
  table.append(heading, rowContainer);
  if (node) {
    const metrics = createMetricRow();
    metricRows.set(rowContainer, metrics);
    metrics.update(node);
    rowContainer.append(metrics.row);
  }
  container.replaceChildren(control, title, table);
}

export function updateDetailCore(container: HTMLElement, node: NodeState | null, view: StatusView): void {
  const status = container.querySelector<HTMLButtonElement>('[data-role="status"]');
  const panel = container.querySelector<HTMLElement>('[data-role="status-panel"]');
  const title = container.querySelector<HTMLElement>('[data-role="name"]');
  const row = container.querySelector<HTMLElement>('.metric-row-container');
  if (!status || !panel || !title || !row) {
    return;
  }
  renderStatusButton(status, node, view);
  renderStatusPanel(panel, view);
  updateDetailName(title, node);
  if (node) {
    metricRows.get(row)?.update(node);
  }
}

function createHistoryView(options: DetailOptions) {
  const section = element('section', 'latency');
  const heading = element('div', 'latency-heading');
  const controls = element('div', 'latency-left');
  const metricMenu = createMetricMenu(options.handlers.onMetricChange);

  const ranges = element('div', 'range-set');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'History range');
  const rangeButtons = LATENCY_RANGES.map((range) => {
    const button = element('button', 'range');
    button.type = 'button';
    button.textContent = range.label;
    button.addEventListener('click', () => options.handlers.onRangeChange(range.hours));
    ranges.append(button);
    return { hours: range.hours, button };
  });
  controls.append(metricMenu.element, ranges);
  heading.append(controls);
  section.append(heading);
  return { section, heading, metricMenu, rangeButtons, query: null as LatencyQuery | null, key: '' };
}

const historyViews = new WeakMap<Element, ReturnType<typeof createHistoryView>>();

export function dismissMetricMenuOutside(container: HTMLElement, target: EventTarget | null): void {
  const section = container.firstElementChild;
  const view = section && historyViews.get(section);
  if (view && target instanceof Node && !view.metricMenu.element.contains(target)) {
    view.metricMenu.close();
  }
}

/** Everything besides the query object that shapes the chart. */
function historySignature(options: DetailOptions): string {
  return JSON.stringify([
    options.metric,
    options.historyState,
    options.historyRange,
    options.displayedHistoryRange,
    options.visibleTaskIds,
    [...options.targets],
    [...options.probeIntervals],
    [...options.colorAssignments],
    options.overflowTaskIds,
  ]);
}

export function renderDetailView(container: HTMLElement, options: DetailOptions): void {
  // Periodic redraws keep the same node's core in place, so hovering or focusing
  // the status (which reveals the outage list) survives them; only the rest is rebuilt.
  const key = options.node?.metadata.uuid ?? '';
  let section = container.querySelector<HTMLElement>(':scope > section.detail');
  const existingCore = section?.querySelector<HTMLElement>(':scope > .detail-core') ?? null;
  const historyKey = historySignature(options);
  if (section && existingCore && existingCore.dataset.node === key) {
    updateDetailCore(existingCore, options.node, options.status);
    // Redraws triggered by live data, the node list or task names leave the latency
    // inputs unchanged; keep the charts so a hover readout is not interrupted.
    const kept = historyViews.get(section);
    if (options.node && kept && kept.query === options.history && kept.key === historyKey) {
      section.querySelectorAll<HTMLElement>('.chart-container').forEach((chart) => setChartOffline(chart, options.status.outages ?? []));
      return;
    }
  } else {
    section = element('section', 'detail');
    const core = element('div', 'detail-core');
    core.dataset.node = key;
    renderCore(core, options.node, options.status, options.handlers);
    section.append(core);
    container.replaceChildren(section);
  }

  if (!options.node) {
    section.querySelector(':scope > .empty-state')?.remove();
    const missing = element('div', 'empty-state danger');
    missing.textContent = 'node not found';
    section.append(missing);
    return;
  }

  const resource = options.metric !== 'latency' ? options.metric : undefined;
  const taskLabels = resource === 'cpu' ? new Map([['cpu.usage', 'CPU usage']])
    : resource === 'mem' ? new Map([['memory.used', 'Memory used']])
    : resource === 'network' ? new Map([
      ['net.in.rate', '↓ DOWN'],
      ['net.out.rate', '↑ UP'],
    ]) : new Map(options.targets);
  const colors = resource ? new Map([
    ['cpu.usage', '#35f477'],
    ['memory.used', '#35f477'],
    ['net.in.rate', '#56aaff'],
    ['net.out.rate', '#ffc45b'],
  ]) : options.colorAssignments;
  const taskIds = [...taskLabels.keys()];

  let historyView = historyViews.get(section);
  if (!historyView) {
    historyView = createHistoryView(options);
    historyViews.set(section, historyView);
    section.append(historyView.section);
  }
  const { section: latencySection, heading, metricMenu, rangeButtons } = historyView;
  // Keep the controls mounted across range changes and periodic chart refreshes.
  metricMenu.update(options.metric);
  for (const { hours, button } of rangeButtons) {
    const selected = options.historyRange === hours;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  heading.querySelector(':scope > .probe-set')?.remove();
  while (heading.nextElementSibling) {
    heading.nextElementSibling.remove();
  }

  const probes = element('div', 'probe-set');
  probes.setAttribute('role', 'group');
  probes.setAttribute('aria-label', resource ? 'Chart series' : 'Visible latency targets');
  taskIds.forEach((taskId) => {
    if (resource) {
      const item = element('span', 'probe');
      const swatch = element('span', 'probe-swatch');
      swatch.style.backgroundColor = colors.get(taskId) ?? '';
      swatch.setAttribute('aria-hidden', 'true');
      item.append(swatch, taskLabels.get(taskId) ?? taskId);
      probes.append(item);
      return;
    }
    const button = element('button', `probe${options.visibleTaskIds.includes(taskId) ? ' active' : ''}`);
    button.type = 'button';
    const dot = element('span', 'probe-swatch');
    dot.style.backgroundColor = options.colorAssignments.get(taskId) ?? latencySeriesColor(taskId, taskIds);
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot);
    const label = element('span');
    label.textContent = taskLabels.get(taskId) ?? taskId;
    button.append(label);
    // Range totals: mean of replied probes, ±jitter, loss.
    const stats = latencyStats(options.history?.series.find((series) => series.taskId === taskId)?.points ?? []);
    if (stats.mean !== null) {
      const mean = element('span', 'probe-stat');
      mean.textContent = `${Math.round(stats.mean)}ms`;
      button.append(mean);
      if (stats.jitter !== null) {
        const jitter = element('span', 'probe-stat muted');
        jitter.textContent = `±${Math.round(stats.jitter)}`;
        button.append(jitter);
      }
    }
    if (stats.loss !== null) {
      const loss = element('span', `probe-stat ${lossTone(stats.loss)}`);
      loss.textContent = formatLoss(stats.loss);
      button.append(loss);
    }
    button.setAttribute('aria-pressed', String(options.visibleTaskIds.includes(taskId)));
    button.addEventListener('click', () => options.handlers.onTaskToggle(taskId));
    probes.append(button);
  });
  heading.append(probes);

  const chart = element('div', 'chart-container');
  chart.dataset.role = resource ? 'resource-chart' : 'latency-chart';
  const displayedRange = options.displayedHistoryRange;
  if (options.historyState !== 'ready') {
    const rangeLabel = (hours: number) => LATENCY_RANGES.find((range) => range.hours === hours)?.label ?? `${hours}h`;
    const requested = rangeLabel(options.historyRange);
    const failed = options.historyState === 'error';
    const status = element('div', `chart-message ${failed ? 'danger' : 'muted'}`);
    const label = element('span');
    label.setAttribute('role', failed ? 'alert' : 'status');
    label.textContent = failed ? `unable to load ${requested}` : `loading ${requested}`;
    if (displayedRange !== null) {
      const shown = rangeLabel(displayedRange);
      label.append(` · showing ${shown}`);
    }
    status.append(label);
    if (failed) {
      const retry = element('button', 'retry');
      retry.type = 'button';
      retry.textContent = 'retry';
      retry.addEventListener('click', options.handlers.onHistoryRetry);
      status.append(' ', retry);
    }
    latencySection.append(status);
  }
  if (displayedRange !== null && options.history) {
    renderLatencyChart(chart, {
      query: options.history,
      visibleTaskIds: resource ? taskIds : options.visibleTaskIds.filter((taskId) => !options.overflowTaskIds.includes(taskId)),
      allTaskIds: taskIds,
      colorAssignments: colors,
      labels: taskLabels,
      rangeHours: displayedRange,
      probeIntervals: options.probeIntervals,
      offline: options.status.outages ?? [],
      resource,
      laneTaskIds: taskIds.filter((taskId) => !options.overflowTaskIds.includes(taskId)),
    });
  }
  latencySection.append(chart);

  const overflowIds = displayedRange === null ? [] : options.overflowTaskIds.filter((taskId) => options.visibleTaskIds.includes(taskId));
  overflowIds.forEach((taskId) => {
    const overflow = element('section', 'latency-overflow');
    const heading = element('h3', 'latency-overflow-title');
    heading.textContent = `${taskLabels.get(taskId) ?? taskId} latency`;
    const overflowChart = element('div', 'chart-container latency-overflow-chart');
    const overflowSeries = options.history?.series.filter((series) => series.taskId === taskId) ?? [];
    if (displayedRange === null || !options.history || overflowSeries.length === 0) {
      const empty = element('div', 'chart-message muted');
      empty.textContent = 'no latency records';
      overflowChart.append(empty);
    } else {
      renderLatencyChart(overflowChart, {
        query: { ...options.history, series: overflowSeries },
        visibleTaskIds: [taskId],
        allTaskIds: [taskId],
        colorAssignments: new Map([[taskId, latencySeriesColor(taskId)]]) as LatencyColorAssignment,
        labels: taskLabels,
        rangeHours: displayedRange,
        probeIntervals: options.probeIntervals,
        offline: options.status.outages ?? [],
      });
    }
    overflow.append(heading, overflowChart);
    latencySection.append(overflow);
  });

  historyView.query = options.history;
  historyView.key = historyKey;
}

