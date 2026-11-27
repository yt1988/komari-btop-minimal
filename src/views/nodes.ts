import { updateClass, updateText } from './dom';
import { formatPercent, formatSpeed, metricTone, networkTone, progressBar } from '../format';
import { normalizeRegionCode, regionFlagUrl } from '../region';
import type { NodeState } from '../domain';
import { createTrafficCell } from './traffic';

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

function createResourceCell(label: string) {
  const cell = element('div', `resource resource-${label.toLowerCase()}`);
  cell.dataset.mobileLabel = label;
  const bar = element('span', 'resource-bar');
  const text = element('span', 'percent');
  const unavailable = element('span');
  unavailable.textContent = '--';

  return {
    cell,
    update(value: number | null, online: boolean): void {
      if (value === null || !Number.isFinite(value) || !online) {
        updateClass(unavailable, online ? 'muted' : 'danger');
        if (cell.firstChild !== unavailable) cell.replaceChildren(unavailable);
        return;
      }
      const percent = Math.max(0, Math.min(100, value));
      const tone = metricTone(percent) === 'warning' ? 'warn' : 'ok';
      updateClass(bar, `resource-bar ${tone}`);
      updateClass(text, `percent ${tone}`);
      updateText(bar, progressBar(percent, 100, 10));
      updateText(text, formatPercent(percent));
      if (cell.firstChild !== bar) cell.replaceChildren(bar, text);
    },
  };
}

function resourceRatio(used: number | null | undefined, total: number | null | undefined): number | null {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) {
    return null;
  }
  return used / total * 100;
}

function createNetworkCell() {
  const network = element('div', 'network');
  network.dataset.mobileLabel = 'NETWORK';
  const directions = (['down', 'up'] as const).map((direction) => {
    const speed = element('span', `direction ${direction}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    speed.append(arrow, text);
    network.append(speed);
    return { direction, speed, text };
  });

  return {
    cell: network,
    update(node: NodeState): void {
      for (const { direction, speed, text } of directions) {
        const value = node.report?.network?.[direction];
        updateText(text, node.online ? formatSpeed(value) : '--');
        const tone = !node.online ? 'danger' : value == null ? 'muted' : networkTone(value) === 'warning' ? 'warn' : 'ok';
        updateClass(speed, `direction ${direction} ${tone}`);
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
  // A pointer or focus resting on the name for 250ms prefetches the detail page's data.
  let intent: ReturnType<typeof setTimeout> | undefined;
  const startIntent = (): void => {
    clearTimeout(intent);
    intent = setTimeout(() => {
      if (name.isConnected) handlers.onNodeIntent?.(uuid);
    }, 250);
  };
  const cancelIntent = (): void => clearTimeout(intent);
  name.addEventListener('pointerenter', startIntent);
  name.addEventListener('focus', startIntent);
  name.addEventListener('pointerleave', cancelIntent);
  name.addEventListener('blur', cancelIntent);
  nodeCell.append(status, name);
  const cpu = createResourceCell('CPU');
  const network = createNetworkCell();
  const memory = createResourceCell('MEM');
  const disk = createResourceCell('DISK');
  const traffic = createTrafficCell();
  row.append(nodeCell, cpu.cell, memory.cell, disk.cell, network.cell, traffic.cell);
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
    cpu.update(report?.cpuUsage ?? null, node.online);
    network.update(node);
    memory.update(resourceRatio(report?.ram?.used, report?.ram?.total), node.online);
    disk.update(resourceRatio(report?.disk?.used, report?.disk?.total), node.online);
    traffic.update(node);
  };
  return { row, update };
}

function renderFilters(filters: HTMLElement, groups: string[], selectedGroup: string, handlers: NodeListHandlers): void {
  const focused = document.activeElement;
  const existing = new Map([...filters.querySelectorAll('button')].map((button) => [button.dataset.group, button]));
  const current = new Set(groups);
  for (const [group, button] of existing) {
    if (group !== undefined && !current.has(group)) button.remove();
  }
  const emojiLabels: Record<string, string> = {
    '🏠': 'Home nodes',
    '🌐': 'Global nodes',
    '🌍': 'Global nodes',
    '🌎': 'Global nodes',
    '🌏': 'Global nodes',
  };
  const emojiOnly = (value: string): boolean => /^\p{Extended_Pictographic}(?:️|︎)?$/u.test(value);
  let previous: HTMLButtonElement | null = null;
  for (const group of groups) {
    let button = existing.get(group);
    if (!button) {
      button = element('button');
      button.type = 'button';
      button.dataset.group = group;
      if (emojiOnly(group)) {
        button.setAttribute('aria-label', emojiLabels[group] ?? 'Icon node group');
        const emoji = element('span', 'filter-emoji');
        emoji.textContent = group;
        emoji.setAttribute('aria-hidden', 'true');
        button.append(emoji);
      } else {
        button.textContent = group;
      }
      button.addEventListener('click', () => handlers.onGroupSelect(group));
    }
    updateClass(button, `filter${selectedGroup === group ? ' active' : ''}`);
    const pressed = String(selectedGroup === group);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    const next: Element | null = previous ? previous.nextElementSibling : filters.firstElementChild;
    if (next !== button) filters.insertBefore(button, next);
    previous = button;
  }
  if (focused instanceof HTMLButtonElement && filters.contains(focused) && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
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
  const focused = document.activeElement;
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

  if (focused instanceof HTMLButtonElement && table.contains(focused) && document.activeElement !== focused) {
    focused.focus({ preventScroll: true });
  }
  table.querySelector('.empty-state')?.remove();
  if (nodes.length === 0) {
    const message = element('div', `empty-state ${emptyMessage === 'unable to load nodes' ? 'danger' : 'muted'}`);
    message.textContent = emptyMessage;
    end.before(message);
  }
}
