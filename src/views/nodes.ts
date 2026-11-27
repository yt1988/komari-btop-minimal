import { formatPercent, formatSpeed, metricTone, networkTone, progressBar } from '../format';
import { normalizeRegionCode, regionFlagUrl } from '../region';
import type { NodeState, ResourceMetric } from '../domain';
import { createTrafficCell } from './traffic';

export type NodeListHandlers = {
  onGroupSelect: (group: string) => void;
  onNodeSelect: (uuid: string) => void;
  onTrendSelect: (uuid: string, metric: ResourceMetric) => void;
  /** A pointer or focus resting on a node name; used to prefetch its detail data. */
  onNodeIntent?: (uuid: string) => void;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function addTone(node: HTMLElement, tone: 'normal' | 'warning', online: boolean): void {
  node.classList.add(!online ? 'danger' : tone === 'warning' ? 'warn' : 'ok');
}

function regionFlag(code: string): HTMLImageElement {
  const flag = element('img', 'node-flag');
  flag.src = regionFlagUrl(code);
  flag.alt = `${code} flag`;
  flag.title = code;
  flag.addEventListener('error', () => {
    if (flag.dataset.fallback === 'true') {
      return;
    }
    flag.dataset.fallback = 'true';
    flag.src = regionFlagUrl('');
  });
  return flag;
}

function renderResource(cell: HTMLDivElement, value: number | null, online: boolean): void {
  if (value === null || !Number.isFinite(value) || !online) {
    const unavailable = element('span', online ? 'muted' : 'danger');
    unavailable.textContent = '--';
    cell.replaceChildren(unavailable);
    return;
  }
  const percent = Math.max(0, Math.min(100, value));
  const tone = metricTone(percent);
  const bar = element('span', `resource-bar ${tone === 'warning' ? 'warn' : 'ok'}`);
  bar.textContent = progressBar(percent, 100, 10);
  const text = element('span', `percent ${tone === 'warning' ? 'warn' : 'ok'}`);
  text.textContent = formatPercent(percent);
  cell.replaceChildren(bar, text);
}

function resourceRatio(used: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return null;
  }
  return used / total * 100;
}

function createMetricLinks(uuid: string, handlers: NodeListHandlers) {
  const cpu = element('div', 'resource resource-cpu');
  cpu.dataset.mobileLabel = 'CPU';
  const bar = element('span', 'resource-bar');
  bar.setAttribute('aria-hidden', 'true');
  const percent = element('button', 'percent trend-link');
  percent.type = 'button';
  percent.addEventListener('click', () => handlers.onTrendSelect(uuid, 'cpu'));
  cpu.append(bar, percent);

  const network = element('div', 'network');
  network.dataset.mobileLabel = 'NETWORK';
  const directions = (['down', 'up'] as const).map((direction) => {
    const speed = element('button', `direction ${direction} trend-link`);
    speed.type = 'button';
    speed.addEventListener('click', () => handlers.onTrendSelect(uuid, 'network'));
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    speed.append(arrow, text);
    network.append(speed);
    return { direction, speed, text };
  });

  return {
    cpu,
    network,
    update(node: NodeState): void {
      const usage = node.report?.cpuUsage;
      const available = node.online && usage != null;
      const tone = !node.online ? 'danger' : !available ? 'muted' : metricTone(usage) === 'warning' ? 'warn' : 'ok';
      bar.hidden = !available;
      bar.className = `resource-bar ${tone}`;
      bar.textContent = available ? progressBar(Math.max(0, Math.min(100, usage)), 100, 10) : '';
      percent.className = `percent trend-link ${tone}`;
      percent.textContent = available ? formatPercent(usage) : '--';
      percent.setAttribute('aria-label', `${node.metadata.name} CPU history, ${percent.textContent}`);
      for (const { direction, speed, text } of directions) {
        const value = node.report?.network?.[direction];
        text.textContent = node.online ? formatSpeed(value) : '--';
        speed.className = `direction ${direction} trend-link`;
        if (!node.online) {
          speed.classList.add('danger');
        } else if (value == null) {
          speed.classList.add('muted');
        } else {
          addTone(speed, networkTone(value), true);
        }
        speed.setAttribute('aria-label', `${node.metadata.name} network history, ${direction === 'down' ? 'download' : 'upload'} ${text.textContent}`);
      }
    },
  };
}

type NodeRow = {
  row: HTMLDivElement;
  update: (node: NodeState) => void;
};

function createNodeRow(uuid: string, handlers: NodeListHandlers): NodeRow {
  const row = element('div', 'row');
  row.dataset.nodeUuid = uuid;
  const nodeCell = element('div', 'node');
  const status = element('span', 'node-status');
  status.textContent = '●';
  status.setAttribute('role', 'img');
  const name = element('button', 'node-name');
  name.type = 'button';
  name.addEventListener('click', () => handlers.onNodeSelect(uuid));
  // A pointer or focus resting on the name for 150ms prefetches the detail page's data.
  let intent: ReturnType<typeof setTimeout> | undefined;
  const startIntent = (): void => {
    clearTimeout(intent);
    intent = setTimeout(() => handlers.onNodeIntent?.(uuid), 150);
  };
  const cancelIntent = (): void => clearTimeout(intent);
  name.addEventListener('pointerenter', startIntent);
  name.addEventListener('focus', startIntent);
  name.addEventListener('pointerleave', cancelIntent);
  name.addEventListener('blur', cancelIntent);
  nodeCell.append(status, name);
  const trends = createMetricLinks(uuid, handlers);
  const memory = element('div', 'resource resource-mem');
  memory.dataset.mobileLabel = 'MEM';
  const disk = element('div', 'resource resource-disk');
  disk.dataset.mobileLabel = 'DISK';
  const traffic = createTrafficCell();
  row.append(nodeCell, trends.cpu, memory, disk, trends.network, traffic.cell);
  let flag: HTMLImageElement | null = null;

  const update = (node: NodeState): void => {
    const liveness = !node.live ? 'pending' : node.online ? 'online' : 'offline';
    if (status.getAttribute('aria-label') !== liveness) {
      status.className = `node-status ${liveness}`;
      status.setAttribute('aria-label', liveness);
    }
    if (name.textContent !== node.metadata.name) {
      name.textContent = node.metadata.name;
    }
    const code = normalizeRegionCode(node.metadata.region);
    if ((flag?.title ?? '') !== code) {
      flag?.remove();
      flag = code ? regionFlag(code) : null;
      if (flag) {
        name.before(flag);
      }
    }

    const report = node.report;
    trends.update(node);
    renderResource(memory, resourceRatio(report?.ram?.used, report?.ram?.total), node.online);
    renderResource(disk, resourceRatio(report?.disk?.used, report?.disk?.total), node.online);
    traffic.update(node);
  };
  return { row, update };
}

function renderFilters(filters: HTMLElement, groups: string[], selectedGroup: string, handlers: NodeListHandlers): void {
  filters.replaceChildren();
  const emojiLabels: Record<string, string> = {
    '🏠': 'Home nodes',
    '🌐': 'Global nodes',
    '🌍': 'Global nodes',
    '🌎': 'Global nodes',
    '🌏': 'Global nodes',
  };
  const emojiOnly = (value: string): boolean => /^\p{Extended_Pictographic}(?:️|︎)?$/u.test(value);
  groups.forEach((group) => {
    const button = element('button', `filter${selectedGroup === group ? ' active' : ''}`);
    button.type = 'button';
    if (emojiOnly(group)) {
      button.setAttribute('aria-label', emojiLabels[group] ?? 'Icon node group');
      const emoji = element('span', 'filter-emoji');
      emoji.textContent = group;
      emoji.setAttribute('aria-hidden', 'true');
      button.append(emoji);
    } else {
      button.textContent = group;
    }
    button.setAttribute('aria-pressed', String(selectedGroup === group));
    button.addEventListener('click', () => handlers.onGroupSelect(group));
    filters.append(button);
  });
}

function createNodeList(container: HTMLElement) {
  const section = element('section', 'nodes');
  const command = element('div', 'command');
  const filters = element('div', 'filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter nodes by group');
  command.append(filters);
  section.append(command);

  const scroll = element('div', 'table-scroll');
  const table = element('div', 'table');
  const header = element('div', 'head');
  ['NODE', 'CPU', 'MEM', 'DISK', 'NETWORK', 'TRAFFIC'].forEach((label) => {
    const column = element('div');
    column.textContent = label;
    header.append(column);
  });
  table.append(header);

  const end = element('div', 'table-end');
  table.append(end);
  scroll.append(table);
  section.append(scroll);
  container.replaceChildren(section);
  return { section, filters, header, end, table, rows: new Map<string, NodeRow>() };
}

// A list's rows live only as long as its mounted section.
const lists = new WeakMap<Element, ReturnType<typeof createNodeList>>();

export function updateNodeRows(container: HTMLElement, nodes: NodeState[], changedUuids: ReadonlySet<string>): void {
  const rows = container.firstElementChild && lists.get(container.firstElementChild)?.rows;
  if (!rows) {
    return;
  }
  for (const node of nodes) {
    if (changedUuids.has(node.metadata.uuid)) {
      rows.get(node.metadata.uuid)?.update(node);
    }
  }
}

export function renderNodeList(
  container: HTMLElement,
  nodes: NodeState[],
  selectedGroup: string,
  handlers: NodeListHandlers,
  emptyMessage = 'no nodes',
): void {
  let list = container.firstElementChild && lists.get(container.firstElementChild);
  if (!list) {
    list = createNodeList(container);
    lists.set(list.section, list);
  }
  const { filters, header, end, table, rows } = list;
  const groups = ['all', ...new Set(nodes.map((node) => node.metadata.group.trim()).filter((group) => group && group.toLowerCase() !== 'offline' && group.toLowerCase() !== 'all'))];
  const filterKey = JSON.stringify([groups, selectedGroup]);
  if (filters.dataset.key !== filterKey) {
    renderFilters(filters, groups, selectedGroup, handlers);
    filters.dataset.key = filterKey;
  }

  const visible = nodes.filter((node) => selectedGroup === 'all' || node.metadata.group.trim() === selectedGroup);
  const visibleIds = new Set(visible.map((node) => node.metadata.uuid));
  for (const [uuid, entry] of rows) {
    if (!visibleIds.has(uuid)) {
      entry.row.remove();
      rows.delete(uuid);
    }
  }
  let previous: Element = header;
  for (const node of visible) {
    const uuid = node.metadata.uuid;
    let entry = rows.get(uuid);
    if (!entry) {
      entry = createNodeRow(uuid, handlers);
      rows.set(uuid, entry);
    }
    entry.update(node);
    if (previous.nextElementSibling !== entry.row) {
      previous.after(entry.row);
    }
    previous = entry.row;
  }

  table.querySelector('.empty-state')?.remove();
  if (nodes.length === 0) {
    const message = element('div', `empty-state ${emptyMessage === 'unable to load nodes' ? 'danger' : 'muted'}`);
    message.textContent = emptyMessage;
    end.before(message);
  }
}
