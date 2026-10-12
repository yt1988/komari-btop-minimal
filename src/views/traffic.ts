import { formatTraffic } from '../format';
import type { NodeState } from '../domain';
import { getTrafficPresentation } from '../traffic';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

export function renderTrafficCell(node: NodeState, className = 'traffic'): HTMLDivElement {
  const cell = element('div', className);
  cell.dataset.mobileLabel = 'TRAFFIC';

  const network = node.report?.network;
  const hasTotals = network !== null && network !== undefined;
  const current = element('div', 'traffic-current');
  for (const [direction, value] of [['down', network?.totalDown], ['up', network?.totalUp]] as const) {
    const tone = !node.online && hasTotals ? 'danger' : hasTotals ? 'ok' : node.online ? 'muted' : 'danger';
    const total = element('span', `direction ${direction} ${tone}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    text.textContent = hasTotals && typeof value === 'number' ? formatTraffic(value) : '--';
    total.append(arrow, text);
    current.append(total);
  }
  cell.append(current);

  const presentation = getTrafficPresentation(
    { up: network?.totalUp ?? null, down: network?.totalDown ?? null },
    node.metadata.trafficLimit,
    node.metadata.trafficLimitType,
  );
  const limitRow = element('div', `traffic-limit${presentation.tone === 'warning' ? ' warn' : ''}`);
  if (!presentation.limited || !hasTotals) {
    limitRow.classList.add('is-empty');
  } else if (!node.online) {
    limitRow.classList.add('danger');
  }

  const track = element('span', 'limit-track');
  const fill = element('span', 'limit-fill');
  fill.style.width = `${presentation.ratio * 100}%`;
  track.append(fill);
  const text = element('span', 'limit-text');
  const limit = presentation.limit === null ? '--' : formatTraffic(presentation.limit);
  text.textContent = hasTotals ? `${formatTraffic(presentation.used)} / ${limit}` : `-- / ${limit}`;
  limitRow.append(track, text);
  cell.append(limitRow);
  return cell;
}
