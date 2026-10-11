import { formatBytes, formatPercent, formatSpeed, metricTone, networkTone } from '../format';
import type { LatencyQuery, NodeState, PingTask } from '../domain';
import { LATENCY_RANGES } from '../latency';
import { renderLatencyChart } from './chart';

export type DetailHandlers = {
  onBack: () => void;
  onRangeChange: (hours: number) => void;
  onTaskToggle: (taskId: string) => void;
};

export type DetailOptions = {
  node: NodeState | null;
  tasks: PingTask[];
  latency: LatencyQuery | null;
  latencyState: 'loading' | 'ready' | 'error';
  latencyRange: number;
  visibleTaskIds: string[];
  handlers: DetailHandlers;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function appendMetricRow(container: HTMLElement, node: NodeState | null): void {
  const row = element('div', 'metric-row');
  if (!node) {
    container.replaceChildren(row);
    return;
  }
  const report = node.report;
  const values: string[] = [
    report?.cpuUsage === null || report?.cpuUsage === undefined ? '--' : formatPercent(report.cpuUsage),
    report?.ram ? `${formatBytes(report.ram.used)} / ${formatBytes(report.ram.total)}` : '--',
    report?.disk ? `${formatBytes(report.disk.used)} / ${formatBytes(report.disk.total)}` : '--',
    '',
    report?.network ? `↓ ${formatBytes(report.network.totalDown)}  ↑ ${formatBytes(report.network.totalUp)}` : '--',
  ];
  const tones = [
    report?.cpuUsage === null || report?.cpuUsage === undefined ? 'muted' : metricTone(report.cpuUsage) === 'warning' ? 'warn' : 'ok',
    report?.ram ? 'ok' : 'muted',
    report?.disk ? 'ok' : 'muted',
    report?.network ? 'ok' : 'muted',
    report?.network ? 'ok' : 'muted',
  ];
  if (!node.online) {
    tones.fill('danger');
  }
  values.forEach((value, index) => {
    const metric = element('div', tones[index] ?? 'muted');
    if (index === 3 && report?.network) {
      const down = element('span', networkTone(report.network.down) === 'warning' ? 'warn' : 'ok');
      down.textContent = `↓ ${formatSpeed(report.network.down)}`;
      const up = element('span', networkTone(report.network.up) === 'warning' ? 'warn' : 'ok');
      up.textContent = `↑ ${formatSpeed(report.network.up)}`;
      metric.append(down, document.createTextNode('  '), up);
      if (!node.online) {
        metric.className = 'danger';
      }
    } else if (index === 3) {
      metric.textContent = '--';
    } else {
      metric.textContent = value;
    }
    row.append(metric);
  });
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

  const title = element('h2', 'detail-name');
  title.textContent = node?.metadata.name ?? '';
  title.dataset.role = 'name';

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
  title.textContent = node?.metadata.name ?? '';
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

  const assignedTasks = options.tasks.filter((task) => task.clients.includes(options.node!.metadata.uuid));
  const taskLabels = new Map(assignedTasks.map((task) => [task.id, task.name]));
  for (const series of options.latency?.series ?? []) {
    if (!taskLabels.has(series.taskId)) {
      taskLabels.set(series.taskId, series.label);
    }
  }
  const taskIds = [...taskLabels.keys()];

  const latencySection = element('section', 'latency');
  const heading = element('div', 'latency-heading');
  const title = element('strong');
  title.textContent = 'latency';
  heading.append(title);

  const ranges = element('div', 'range-set');
  LATENCY_RANGES.forEach((range) => {
    const button = element('button', `range${options.latencyRange === range.hours ? ' active' : ''}`);
    button.type = 'button';
    button.textContent = range.label;
    button.setAttribute('aria-pressed', String(options.latencyRange === range.hours));
    button.addEventListener('click', () => options.handlers.onRangeChange(range.hours));
    ranges.append(button);
  });
  heading.append(ranges);

  const probes = element('div', 'probe-set');
  taskIds.forEach((taskId) => {
    const button = element('button', `probe${options.visibleTaskIds.includes(taskId) ? ' active' : ''}`);
    button.type = 'button';
    button.textContent = taskLabels.get(taskId) ?? taskId;
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
    loading.textContent = 'loading latency';
    chart.append(loading);
  } else if (options.latencyState === 'error') {
    const error = element('div', 'chart-message danger');
    error.textContent = 'latency unavailable';
    chart.append(error);
  } else {
    renderLatencyChart(chart, {
      query: options.latency,
      visibleTaskIds: options.visibleTaskIds.length ? options.visibleTaskIds : taskIds,
      labels: taskLabels,
      rangeHours: options.latencyRange,
    });
  }
  latencySection.append(chart);
  section.append(latencySection);
  container.replaceChildren(section);
}

