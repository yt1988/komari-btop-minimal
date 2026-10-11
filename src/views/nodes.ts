import { formatBytes, formatPercent, formatSpeed, metricTone, networkTone, progressBar } from '../format';
import { normalizeRegionCode, regionFlagDataUrl } from '../region';
import { getTrafficPresentation } from '../traffic';
import type { NodeState } from '../domain';

export type NodeListHandlers = {
  onGroupSelect: (group: string) => void;
  onNodeSelect: (uuid: string) => void;
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

function regionImage(region: string, className: string): HTMLImageElement | null {
  const code = normalizeRegionCode(region);
  if (!code) {
    return null;
  }
  const image = element('img', className);
  image.src = regionFlagDataUrl(code);
  image.alt = `${code} flag`;
  image.title = code;
  return image;
}

function resourceCell(value: number | null, online: boolean): HTMLDivElement {
  const cell = element('div', 'resource');
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

function resourceRatio(used: number | undefined, total: number | undefined): number | null {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return null;
  }
  return used / total * 100;
}

function networkCell(node: NodeState): HTMLDivElement {
  const cell = element('div', 'network');
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

function trafficCell(node: NodeState): HTMLDivElement {
  const cell = element('div', 'traffic');
  const network = node.report?.network;
  const hasTotals = network !== null && network !== undefined;
  const current = element('div', 'traffic-current');
  for (const [direction, value] of [['down', network?.totalDown], ['up', network?.totalUp]] as const) {
    const total = element('span', `direction ${direction} ${!node.online && hasTotals ? 'danger' : hasTotals ? 'ok' : node.online ? 'muted' : 'danger'}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    text.textContent = hasTotals && typeof value === 'number' ? formatBytes(value) : '--';
    total.append(arrow, text);
    current.append(total);
  }
  cell.append(current);

  const presentation = getTrafficPresentation(
    { up: network?.totalUp ?? null, down: network?.totalDown ?? null },
    node.metadata.trafficLimit,
    node.metadata.trafficLimitType,
  );
  if (!presentation.limited) {
    cell.classList.add('has-no-limit');
    return cell;
  }

  const limitRow = element('div', `traffic-limit${presentation.tone === 'warning' ? ' warn' : ''}`);
  if (!hasTotals) {
    limitRow.classList.add('is-empty');
  } else if (!node.online) {
    limitRow.classList.add('danger');
  }
  const track = element('span', 'limit-track');
  const fill = element('span', 'limit-fill');
  fill.style.width = `${presentation.ratio * 100}%`;
  track.append(fill);
  const text = element('span', 'limit-text');
  text.textContent = hasTotals
    ? `${formatBytes(presentation.used)} / ${formatBytes(presentation.limit)}`
    : `-- / ${formatBytes(presentation.limit)}`;
  limitRow.append(track, text);
  cell.append(limitRow);
  return cell;
}

function populateNodeRow(row: HTMLDivElement, node: NodeState, handlers: NodeListHandlers): void {
  const nodeCell = element('div', 'node');
  const status = element('span', `node-status ${node.online ? 'online' : 'offline'}`);
  status.textContent = '●';
  status.setAttribute('aria-label', node.online ? 'online' : 'offline');
  const region = regionImage(node.metadata.region, 'node-flag');
  if (region) {
    nodeCell.append(status, region);
  } else {
    nodeCell.append(status);
  }
  const name = element('button', 'node-name');
  name.type = 'button';
  name.textContent = node.metadata.name;
  name.addEventListener('click', () => handlers.onNodeSelect(node.metadata.uuid));
  nodeCell.append(name);

  const report = node.report;
  row.replaceChildren(
    nodeCell,
    resourceCell(report?.cpuUsage ?? null, node.online),
    resourceCell(resourceRatio(report?.ram?.used, report?.ram?.total), node.online),
    resourceCell(resourceRatio(report?.disk?.used, report?.disk?.total), node.online),
    networkCell(node),
    trafficCell(node),
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
  const groups = ['all', ...new Set(nodes.map((node) => node.metadata.group.trim()).filter((group) => group && group.toLowerCase() !== 'offline' && group.toLowerCase() !== 'all'))];
  groups.forEach((group) => {
    const button = element('button', `filter${selectedGroup === group ? ' active' : ''}`);
    button.type = 'button';
    button.textContent = group;
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

