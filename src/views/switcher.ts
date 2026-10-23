import type { NodeState } from '../domain';
import { normalizeRegionCode, regionFlagUrl } from '../region';

export type NodeSwitcherHandlers = {
  onSelect: (uuid: string) => void;
  /** A pointer resting on an entry; used to prefetch that node's detail data. */
  onIntent?: (uuid: string) => void;
};

function flag(region: string): HTMLImageElement | HTMLSpanElement {
  const code = normalizeRegionCode(region);
  if (!code) {
    return document.createElement('span');
  }
  const image = document.createElement('img');
  image.className = 'node-flag';
  image.src = regionFlagUrl(code);
  image.alt = '';
  image.addEventListener('error', () => {
    if (image.dataset.fallback !== 'true') {
      image.dataset.fallback = 'true';
      image.src = regionFlagUrl('');
    }
  });
  return image;
}

/** A floating list of every node, in node list order, for jumping between detail pages. */
export function renderNodeSwitcher(nodes: readonly NodeState[], currentUuid: string, handlers: NodeSwitcherHandlers): HTMLDivElement {
  const list = document.createElement('div');
  list.className = 'node-switcher';
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', 'Switch node');
  for (const node of nodes) {
    const uuid = node.metadata.uuid;
    const liveness = !node.live ? 'pending' : node.online ? 'online' : 'offline';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `node-switcher-item ${liveness}${uuid === currentUuid ? ' is-current' : ''}`;
    item.setAttribute('role', 'menuitem');
    if (uuid === currentUuid) {
      item.setAttribute('aria-current', 'page');
    }
    const dot = document.createElement('span');
    dot.className = 'node-switcher-dot';
    dot.textContent = node.live && !node.online ? '○' : '●';
    dot.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = node.metadata.name;
    item.append(dot, flag(node.metadata.region), name);
    item.addEventListener('click', () => handlers.onSelect(uuid));
    let intent: ReturnType<typeof setTimeout> | undefined;
    item.addEventListener('pointerenter', () => {
      intent = setTimeout(() => handlers.onIntent?.(uuid), 150);
    });
    item.addEventListener('pointerleave', () => clearTimeout(intent));
    list.append(item);
  }
  // Up and down move between entries for keyboard users.
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const items = [...list.querySelectorAll<HTMLButtonElement>('.node-switcher-item')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
    event.preventDefault();
  });
  return list;
}
