import type { NodeState } from '../domain';
import { formatClock, formatDuration } from '../format';
import type { StatusHistory } from '../statusHistory';

export type StatusView = {
  open: boolean;
  state: 'loading' | 'ready' | 'error';
  history: StatusHistory | null;
  /** Start of the current online or offline state, when known. */
  since: number | null;
  now: number;
};

function span(className: string, text: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

export function renderStatusButton(button: HTMLButtonElement, node: NodeState | null, view: StatusView): void {
  button.className = `detail-status ${node?.online ? 'ok' : 'danger'}`;
  button.setAttribute('aria-expanded', String(view.open));
  button.hidden = node === null;
  if (!node) {
    button.replaceChildren();
    return;
  }
  const label = node.online ? '● online' : '○ offline';
  const since = view.since === null ? '' : ` ${formatDuration(view.now - view.since)}`;
  if (button.textContent === `${label}${since}`) {
    return;
  }
  button.replaceChildren(document.createTextNode(label));
  if (since) {
    button.append(span('muted', since));
  }
}

/**
 * One row per outage, newest first, durations flush right under the status:
 * `↻15:36  15:19–15:40  21m`.
 */
function content(view: StatusView, onRetry: () => void): HTMLElement[] {
  if (view.state === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'retry';
    retry.textContent = 'retry';
    retry.addEventListener('click', onRetry);
    const note = span('status-note danger', 'unavailable ');
    note.append(retry);
    return [note];
  }
  const history = view.history;
  if (!history) {
    return [span('status-note muted', 'loading')];
  }
  const boot = history.boot;
  const within = (interval: { start: number; end: number }): boolean => boot !== null && boot >= interval.start && boot <= interval.end;
  const rows: Array<{ at: number; cells: HTMLElement[] }> = history.intervals.map((interval) => ({
    at: interval.start,
    cells: [
      span('warn', within(interval) ? `↻${formatClock(boot!)}` : ''),
      span('muted', `${formatClock(interval.start)}–${interval.ongoing ? 'now' : formatClock(interval.end)}`),
      span('danger', formatDuration(interval.end - interval.start)),
    ],
  }));
  // A quick reboot can finish between two records and leave no outage behind.
  if (boot !== null && !history.intervals.some(within)) {
    rows.push({ at: boot, cells: [span('', ''), span('warn', `↻${formatClock(boot)}`), span('', '')] });
  }
  if (rows.length === 0) {
    return [span('status-note muted', 'no outages')];
  }
  return rows.sort((left, right) => right.at - left.at).flatMap((row) => row.cells);
}

/** Rebuilds the panel only when its visible content changed, so focus survives live updates. */
export function renderStatusPanel(panel: HTMLElement, view: StatusView, onRetry: () => void): void {
  panel.hidden = !view.open;
  if (!view.open) {
    return;
  }
  const next = content(view, onRetry);
  const signature = next.map((part) => `${part.className}|${part.textContent}`).join('/');
  if (panel.dataset.signature === signature) {
    return;
  }
  panel.dataset.signature = signature;
  panel.replaceChildren(...next);
}
