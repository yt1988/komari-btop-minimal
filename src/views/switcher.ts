import { updateClass, updateText } from './dom';
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

function updateLiveness(item: HTMLElement, dot: HTMLElement, node: NodeState): void {
  const liveness = !node.live ? 'pending' : node.online ? 'online' : 'offline';
  const current = item.getAttribute('aria-current') === 'page' ? ' is-current' : '';
  updateClass(item, `node-switcher-item ${liveness}${current}`);
  updateText(dot, node.live && !node.online ? '○' : '●');
}

type SwitcherItem = {
  button: HTMLButtonElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  region: string;
};

const switchers = new WeakMap<HTMLElement, {
  currentUuid: string;
  handlers: NodeSwitcherHandlers;
  items: Map<string, SwitcherItem>;
}>();

export function updateNodeSwitcher(list: HTMLElement, nodes: readonly NodeState[]): void {
  const view = switchers.get(list);
  if (!view) return;
  const visible = new Set(nodes.map(({ metadata }) => metadata.uuid));
  for (const [uuid, item] of view.items) {
    if (visible.has(uuid)) continue;
    item.button.remove();
    view.items.delete(uuid);
  }
  let previous: HTMLElement | null = null;
  for (const node of nodes) {
    const { uuid, name, region } = node.metadata;
    let item = view.items.get(uuid);
    if (!item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (uuid === view.currentUuid) button.setAttribute('aria-current', 'page');
      const dot = document.createElement('span');
      dot.className = 'node-switcher-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      button.append(dot, flag(region), label);
      button.addEventListener('click', () => view.handlers.onSelect(uuid));
      let intent: ReturnType<typeof setTimeout> | undefined;
      button.addEventListener('pointerenter', () => {
        clearTimeout(intent);
        intent = setTimeout(() => {
          if (button.isConnected) view.handlers.onIntent?.(uuid);
        }, 250);
      });
      button.addEventListener('pointerleave', () => clearTimeout(intent));
      item = { button, dot, name: label, region };
      view.items.set(uuid, item);
    }
    if (item.region !== region) {
      item.button.children[1]?.replaceWith(flag(region));
      item.region = region;
    }
    updateText(item.name, name);
    updateLiveness(item.button, item.dot, node);
    const next: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
    if (next !== item.button) list.insertBefore(item.button, next);
    previous = item.button;
  }
}

/** A floating list of every node, in node list order, for jumping between detail pages. */
export function renderNodeSwitcher(nodes: readonly NodeState[], currentUuid: string, handlers: NodeSwitcherHandlers): HTMLDivElement {
  const list = document.createElement('div');
  list.className = 'node-switcher';
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', 'Switch node');
  switchers.set(list, { currentUuid, handlers, items: new Map() });
  updateNodeSwitcher(list, nodes);
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
