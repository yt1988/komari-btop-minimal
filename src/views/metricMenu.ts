import type { HistoryMetric } from '../domain';

const metricLabels: Record<HistoryMetric, string> = {
  cpu: 'CPU',
  mem: 'MEM',
  network: 'NETWORK',
  latency: 'LATENCY',
};

export function createMetricMenu(onSelect: (metric: HistoryMetric) => void) {
  const element = document.createElement('div');
  element.className = 'history-metric-control';

  const trigger = document.createElement('button');
  trigger.className = 'history-metric';
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'history-metric-menu');
  const label = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 'history-metric-caret';
  caret.textContent = '▾';
  caret.setAttribute('aria-hidden', 'true');
  trigger.append(label, caret);

  const menu = document.createElement('div');
  menu.id = 'history-metric-menu';
  menu.className = 'history-metric-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Chart metric');
  menu.hidden = true;
  element.append(trigger, menu);

  const close = (): void => {
    if (menu.hidden) {
      return;
    }
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const options = (Object.keys(metricLabels) as HistoryMetric[]).map((metric) => {
    const button = document.createElement('button');
    button.className = 'history-metric-option';
    button.type = 'button';
    button.tabIndex = -1;
    button.setAttribute('role', 'menuitemradio');
    button.textContent = metricLabels[metric];
    button.addEventListener('click', () => {
      close();
      trigger.focus();
      onSelect(metric);
    });
    menu.append(button);
    return { metric, button };
  });

  let selected: HistoryMetric | null = null;
  const open = (index: number): void => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    options[index]?.button.focus();
  };

  trigger.addEventListener('click', () => {
    if (menu.hidden) {
      open(options.findIndex(({ metric }) => metric === selected));
    } else {
      close();
    }
  });

  element.addEventListener('focusout', (event) => {
    if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) {
      close();
    }
  });

  element.addEventListener('keydown', (event) => {
    const last = options.length - 1;
    if (menu.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open(event.key === 'ArrowDown' ? 0 : last);
      }
      return;
    }

    if (event.key === 'Escape' || event.key === 'Tab') {
      close();
      trigger.focus();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const index = options.findIndex(({ button }) => button === document.activeElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowUp':
        next = index <= 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    options[next]?.button.focus();
  });

  return {
    element,
    close,
    update(metric: HistoryMetric): void {
      if (metric === selected) {
        return;
      }
      selected = metric;
      label.textContent = metricLabels[metric];
      trigger.setAttribute('aria-label', `Chart metric: ${metricLabels[metric]}`);
      for (const option of options) {
        option.button.setAttribute('aria-checked', String(option.metric === metric));
      }
    },
  };
}
