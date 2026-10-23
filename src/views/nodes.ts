import { formatPercent, formatSpeed, metricTone, networkTone, progressBar } from '../format';
import { normalizeRegionCode, regionFlagUrl } from '../region';
import type { NodeState } from '../domain';
import { renderTrafficCell } from './traffic';

export type NodeListHandlers = {
  onGroupSelect: (group: string) => void;
  onNodeSelect: (uuid: string) => void;
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

function regionFlag(region: string, className: string): HTMLImageElement | null {
  const code = normalizeRegionCode(region);
  if (!code) {
    return null;
  }
  const flag = element('img', className);
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

function resourceCell(value: number | null, online: boolean, label: 'cpu' | 'mem' | 'disk'): HTMLDivElement {
  const cell = element('div', `resource resource-${label}`);
  cell.dataset.mobileLabel = label.toUpperCase();
  if (value === null || !Number.isFinite(value) || !online) {
    const unavailable = element('span', online ? 'muted' : 'danger');
    unavailable.textContent = '--';
    cell.append(unavailable);
    return cell;
  }
  const percent = Math.max(0, Math.min(100, value));
  const tone = metricTone(percent);
  const bar = element('span', `resource-bar ${tone === 'warning' ? 'warn' : 'ok'}`);
  bar.textContent = progressBar(percent, 100, 10);
  const text = element('span', `percent ${tone === 'warning' ? 'warn' : 'ok'}`);
  text.textContent = formatPercent(percent);
  cell.append(bar, text);
  return cell;
}

function resourceRatio(used: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return null;
  }
  return used / total * 100;
}

function networkCell(node: NodeState): HTMLDivElement {
  const cell = element('div', 'network');
  cell.dataset.mobileLabel = 'NETWORK';
  const report = node.report?.network;
  for (const [direction, value] of [['down', report?.down], ['up', report?.up]] as const) {
    const speed = element('span', `direction ${direction}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    text.textContent = node.online && typeof value === 'number' ? formatSpeed(value) : '--';
    speed.append(arrow, text);
    if (!node.online) {
      speed.classList.add('danger');
    } else if (typeof value !== 'number') {
      speed.classList.add('muted');
    } else {
      addTone(speed, networkTone(value), true);
    }
    cell.append(speed);
  }
  return cell;
}

function populateNodeRow(row: HTMLDivElement, node: NodeState, handlers: NodeListHandlers): void {
  const nodeCell = element('div', 'node');
  const liveness = !node.live ? 'pending' : node.online ? 'online' : 'offline';
  const status = element('span', `node-status ${liveness}`);
  status.textContent = '●';
  status.setAttribute('role', 'img');
  status.setAttribute('aria-label', liveness);
  const region = regionFlag(node.metadata.region, 'node-flag');
  if (region) {
    nodeCell.append(status, region);
  } else {
    nodeCell.append(status);
  }
  const name = element('button', 'node-name');
  name.type = 'button';
  name.textContent = node.metadata.name;
  name.addEventListener('click', () => handlers.onNodeSelect(node.metadata.uuid));
  // A pointer or focus resting on the name for 150ms prefetches the detail page's data.
  let intent: ReturnType<typeof setTimeout> | undefined;
  const startIntent = (): void => {
    clearTimeout(intent);
    intent = setTimeout(() => handlers.onNodeIntent?.(node.metadata.uuid), 150);
  };
  const cancelIntent = (): void => clearTimeout(intent);
  name.addEventListener('pointerenter', startIntent);
  name.addEventListener('focus', startIntent);
  name.addEventListener('pointerleave', cancelIntent);
  name.addEventListener('blur', cancelIntent);
  nodeCell.append(name);

  const report = node.report;
  row.replaceChildren(
    nodeCell,
    resourceCell(report?.cpuUsage ?? null, node.online, 'cpu'),
    resourceCell(resourceRatio(report?.ram?.used, report?.ram?.total), node.online, 'mem'),
    resourceCell(resourceRatio(report?.disk?.used, report?.disk?.total), node.online, 'disk'),
    networkCell(node),
    renderTrafficCell(node),
  );
}

function nodeRow(node: NodeState, handlers: NodeListHandlers): HTMLDivElement {
  const row = element('div', 'row');
  row.dataset.nodeUuid = node.metadata.uuid;
  populateNodeRow(row, node, handlers);
  return row;
}

export function updateNodeRows(
  container: HTMLElement,
  nodes: NodeState[],
  handlers: NodeListHandlers,
  changedUuids?: ReadonlySet<string>,
): void {
  const nodesByUuid = new Map(nodes.map((node) => [node.metadata.uuid, node]));
  container.querySelectorAll<HTMLDivElement>('.nodes .row[data-node-uuid]').forEach((row) => {
    const uuid = row.dataset.nodeUuid;
    if (!uuid || (changedUuids && !changedUuids.has(uuid))) {
      return;
    }
    const node = nodesByUuid.get(uuid);
    if (node) {
      populateNodeRow(row, node, handlers);
    }
  });
}

export function renderNodeList(
  container: HTMLElement,
  nodes: NodeState[],
  selectedGroup: string,
  handlers: NodeListHandlers,
  emptyMessage = 'no nodes',
): void {
  const section = element('section', 'nodes');
  const command = element('div', 'command');
  const filters = element('div', 'filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter nodes by group');
  const groups = ['all', ...new Set(nodes.map((node) => node.metadata.group.trim()).filter((group) => group && group.toLowerCase() !== 'offline' && group.toLowerCase() !== 'all'))];
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

  const visibleNodes = selectedGroup === 'all'
    ? nodes
    : nodes.filter((node) => node.metadata.group.trim() === selectedGroup);
  visibleNodes.forEach((node) => table.append(nodeRow(node, handlers)));
  if (nodes.length === 0) {
    const message = element('div', `empty-state ${emptyMessage === 'unable to load nodes' ? 'danger' : 'muted'}`);
    message.textContent = emptyMessage;
    table.append(message);
  }
  const end = element('div', 'table-end');
  table.append(end);
  scroll.append(table);
  section.append(scroll);
  container.replaceChildren(section);
}

