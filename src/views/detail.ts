import { formatBytes, formatPercent, formatSpeed, metricTone, networkTone } from '../format';
import type { LatencyQuery, NodeState } from '../domain';
import { LATENCY_RANGES, latencySeriesColor } from '../latency';
import type { LatencyColorAssignment } from '../latencyColors';
import { normalizeRegionCode, regionFlagUrl } from '../region';
import { renderLatencyChart } from './chart';
import { renderTrafficCell } from './traffic';

export type DetailHandlers = {
  onBack: () => void;
  onRangeChange: (hours: number) => void;
  onLatencyRetry: () => void;
  onTaskToggle: (taskId: string) => void;
};

export type DetailOptions = {
  node: NodeState | null;
  targets: ReadonlyMap<string, string>;
  latency: LatencyQuery | null;
  latencyState: 'loading' | 'ready' | 'error';
  latencyRange: number;
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

function updateDetailName(container: HTMLElement, node: NodeState | null): void {
  container.replaceChildren();
  const code = normalizeRegionCode(node?.metadata.region);
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
    container.append(region);
  }
  const name = element('span', 'detail-name-text');
  name.textContent = node?.metadata.name ?? '';
  container.append(name);
}

function appendMetricRow(container: HTMLElement, node: NodeState | null): void {
  const row = element('div', 'metric-row');
  if (!node) {
    container.replaceChildren(row);
    return;
  }
  const report = node.report;
  const cpu = element('div', `metric metric-cpu ${!node.online ? 'danger' : report?.cpuUsage === null || report?.cpuUsage === undefined ? 'muted' : metricTone(report.cpuUsage) === 'warning' ? 'warn' : 'ok'}`);
  cpu.dataset.mobileLabel = 'CPU';
  cpu.textContent = report?.cpuUsage === null || report?.cpuUsage === undefined ? '--' : formatPercent(report.cpuUsage);

  const memory = element('div', `metric metric-mem ${!node.online ? 'danger' : report?.ram ? 'ok' : 'muted'}`);
  memory.dataset.mobileLabel = 'MEM';
  memory.textContent = report?.ram ? `${formatBytes(report.ram.used)} / ${formatBytes(report.ram.total)}` : '--';

  const disk = element('div', `metric metric-disk ${!node.online ? 'danger' : report?.disk ? 'ok' : 'muted'}`);
  disk.dataset.mobileLabel = 'DISK';
  disk.textContent = report?.disk ? `${formatBytes(report.disk.used)} / ${formatBytes(report.disk.total)}` : '--';

  const network = element('div', `metric metric-network ${!node.online ? 'danger' : report?.network ? 'ok' : 'muted'}`);
  network.dataset.mobileLabel = 'NETWORK';
  for (const [direction, value] of [['down', report?.network?.down], ['up', report?.network?.up]] as const) {
    const tone = !node.online ? 'danger' : typeof value !== 'number' ? 'muted' : networkTone(value) === 'warning' ? 'warn' : 'ok';
    const item = element('span', `direction ${tone}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    text.textContent = typeof value === 'number' ? formatSpeed(value) : '--';
    item.append(arrow, text);
    network.append(item);
  }

  row.append(cpu, memory, disk, network, renderTrafficCell(node, 'metric metric-traffic traffic'));
  container.replaceChildren(row);
}

function renderCore(container: HTMLElement, node: NodeState | null): void {
  const control = element('div', 'detail-control');
  const back = element('button', 'back');
  back.type = 'button';
  back.textContent = '← node list';
  back.dataset.action = 'back';
  const status = element('div', `detail-status ${node?.online ? 'ok' : 'danger'}`);
  status.textContent = node ? `● ${node.online ? 'online' : 'offline'}` : '';
  status.dataset.role = 'status';
  control.append(back, status);

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
  appendMetricRow(rowContainer, node);
  container.replaceChildren(control, title, table);
}

export function updateDetailCore(container: HTMLElement, node: NodeState | null): void {
  const status = container.querySelector<HTMLElement>('[data-role="status"]');
  const title = container.querySelector<HTMLElement>('[data-role="name"]');
  const row = container.querySelector<HTMLElement>('.metric-row-container');
  if (!status || !title || !row) {
    return;
  }
  status.className = `detail-status ${node?.online ? 'ok' : 'danger'}`;
  status.textContent = node ? `● ${node.online ? 'online' : 'offline'}` : '';
  updateDetailName(title, node);
  appendMetricRow(row, node);
}

export function renderDetailView(container: HTMLElement, options: DetailOptions): void {
  const section = element('section', 'detail');
  const core = element('div', 'detail-core');
  renderCore(core, options.node);
  core.querySelector<HTMLButtonElement>('[data-action="back"]')?.addEventListener('click', options.handlers.onBack);
  section.append(core);

  if (!options.node) {
    const missing = element('div', 'empty-state danger');
    missing.textContent = 'node not found';
    section.append(missing);
    container.replaceChildren(section);
    return;
  }

  const taskLabels = new Map(options.targets);
  const taskIds = [...taskLabels.keys()];

  const latencySection = element('section', 'latency');
  const heading = element('div', 'latency-heading');
  const title = element('h2', 'latency-title');
  title.textContent = 'latency';

  const controls = element('div', 'latency-left');
  const ranges = element('div', 'range-set');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Latency range');
  LATENCY_RANGES.forEach((range) => {
    const button = element('button', `range${options.latencyRange === range.hours ? ' active' : ''}`);
    button.type = 'button';
    button.textContent = range.label;
    button.setAttribute('aria-pressed', String(options.latencyRange === range.hours));
    button.addEventListener('click', () => options.handlers.onRangeChange(range.hours));
    ranges.append(button);
  });
  controls.append(title, ranges);
  heading.append(controls);

  const probes = element('div', 'probe-set');
  probes.setAttribute('role', 'group');
  probes.setAttribute('aria-label', 'Visible latency targets');
  taskIds.forEach((taskId) => {
    const button = element('button', `probe${options.visibleTaskIds.includes(taskId) ? ' active' : ''}`);
    button.type = 'button';
    const dot = element('span', 'probe-swatch');
    dot.style.backgroundColor = options.colorAssignments.get(taskId) ?? latencySeriesColor(taskId, taskIds);
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot);
    const label = element('span');
    label.textContent = taskLabels.get(taskId) ?? taskId;
    button.append(label);
    button.setAttribute('aria-pressed', String(options.visibleTaskIds.includes(taskId)));
    button.addEventListener('click', () => options.handlers.onTaskToggle(taskId));
    probes.append(button);
  });
  heading.append(probes);
  latencySection.append(heading);

  const chart = element('div', 'chart-container');
  chart.dataset.role = 'latency-chart';
  if (options.latencyState === 'loading') {
    const loading = element('div', 'chart-message muted');
    loading.setAttribute('role', 'status');
    loading.textContent = 'loading latency';
    chart.append(loading);
  } else if (options.latencyState === 'error') {
    const error = element('div', 'chart-message danger');
    error.setAttribute('role', 'alert');
    error.textContent = 'latency unavailable';
    const retry = element('button', 'retry');
    retry.type = 'button';
    retry.textContent = 'retry';
    retry.addEventListener('click', options.handlers.onLatencyRetry);
    chart.append(error, retry);
  } else {
    renderLatencyChart(chart, {
      query: options.latency,
      visibleTaskIds: options.visibleTaskIds.filter((taskId) => !options.overflowTaskIds.includes(taskId)),
      allTaskIds: taskIds,
      colorAssignments: options.colorAssignments,
      labels: taskLabels,
      rangeHours: options.latencyRange,
    });
  }
  latencySection.append(chart);

  const overflowIds = options.overflowTaskIds.filter((taskId) => options.visibleTaskIds.includes(taskId));
  overflowIds.forEach((taskId) => {
    const overflow = element('section', 'latency-overflow');
    const heading = element('h3', 'latency-overflow-title');
    heading.textContent = `${taskLabels.get(taskId) ?? taskId} latency`;
    const overflowChart = element('div', 'chart-container latency-overflow-chart');
    const overflowSeries = options.latency?.series.filter((series) => series.taskId === taskId) ?? [];
    if (options.latencyState !== 'ready' || overflowSeries.length === 0) {
      const empty = element('div', 'chart-message muted');
      empty.textContent = options.latencyState === 'ready' ? 'no latency records' : 'latency unavailable';
      overflowChart.append(empty);
    } else {
      renderLatencyChart(overflowChart, {
        query: { ...options.latency!, series: overflowSeries },
        visibleTaskIds: [taskId],
        allTaskIds: [taskId],
        colorAssignments: new Map([[taskId, latencySeriesColor(taskId)]]) as LatencyColorAssignment,
        labels: taskLabels,
        rangeHours: options.latencyRange,
      });
    }
    overflow.append(heading, overflowChart);
    latencySection.append(overflow);
  });

  section.append(latencySection);
  container.replaceChildren(section);
}

