import { updateClass } from './dom';
import type { NodeState } from '../domain';
import { formatDayClock, formatDuration } from '../format';
import type { OfflineInterval } from '../statusHistory';

export type StatusView = {
  /** Oldest first; null until loaded. */
  outages: OfflineInterval[] | null;
  now: number;
};

const MAX_ROWS = 5;

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

export function renderStatusButton(button: HTMLButtonElement, node: NodeState | null, view: StatusView): void {
  updateClass(button, `detail-status ${node?.online ? 'ok' : 'danger'}`);
  // Hovering or focusing the status reveals the outage list; without one it is plain text.
  const disabled = (view.outages?.length ?? 0) === 0;
  if (button.disabled !== disabled) button.disabled = disabled;
  // Liveness is unknown until the first snapshot, so the status stays hidden until then.
  const hidden = node === null || !node.live;
  if (button.hidden !== hidden) button.hidden = hidden;
  if (!node) {
    button.replaceChildren();
    return;
  }
  const label = node.online ? '● online' : '○ offline';
  // Only an outage shows how long it has lasted, and only when its start is known.
  const outage = node.online ? undefined : view.outages?.find((interval) => interval.ongoing && !interval.startClipped);
  const since = outage ? ` ${formatDuration(view.now - outage.start)}` : '';
  if (button.textContent === `${label}${since}`) {
    return;
  }
  button.replaceChildren(document.createTextNode(label));
  if (since) {
    button.append(span('muted', since));
  }
}

/** One row per outage, newest first: `○ 15:56  ● 16:19`; the up time sits flush right under the status. */
function rows(outages: readonly OfflineInterval[], now: number): HTMLElement[] {
  const cell = (dot: string, tone: string, time: string): HTMLSpanElement => {
    const node = span('muted', time);
    node.prepend(span(tone, `${dot} `));
    return node;
  };
  const cells = [...outages].reverse().slice(0, MAX_ROWS).flatMap((outage) => [
    cell('○', 'danger', outage.startClipped ? '…' : formatDayClock(outage.start, now)),
    outage.ongoing ? span('', '') : cell('●', 'ok', formatDayClock(outage.end, now)),
  ]);
  if (outages.length > MAX_ROWS) {
    cells.push(span('status-more muted', `+${outages.length - MAX_ROWS}`));
  }
  return cells;
}

/** Rebuilds the list only when its visible content changed; it stays empty without outages. */
export function renderStatusPanel(panel: HTMLElement, view: StatusView): void {
  const outages = view.outages ?? [];
  const signature = JSON.stringify([
    outages.length,
    outages.length > 0 ? new Date(view.now).toDateString() : '',
    ...outages.slice(-MAX_ROWS).map(({ start, end, ongoing, startClipped }) => [start, ongoing ? null : end, startClipped]),
  ]);
  if (panel.dataset.signature === signature) {
    return;
  }
  panel.dataset.signature = signature;
  panel.replaceChildren(...rows(outages, view.now));
}
