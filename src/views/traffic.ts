import { formatTraffic } from '../format';
import type { NodeState } from '../domain';
import { getTrafficPresentation } from '../traffic';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const rules = {
  sum: ['↕', 'Upload plus download', '上传和下载相加'],
  up: ['↑', 'Upload only', '只计上传'],
  down: ['↓', 'Download only', '只计下载'],
  max: ['MAX', 'Higher of upload and download', '取上传和下载中的较大值'],
  min: ['MIN', 'Lower of upload and download', '取上传和下载中的较小值'],
} as const;

export function createTrafficCell(className = 'traffic') {
  const cell = element('div', className);
  cell.dataset.mobileLabel = 'TRAFFIC';
  const current = element('div', 'traffic-current');
  const totals = (['down', 'up'] as const).map((direction) => {
    const total = element('span', `direction ${direction}`);
    const arrow = element('span', 'direction-arrow');
    arrow.textContent = direction === 'down' ? '↓' : '↑';
    const text = element('span', 'direction-value');
    total.append(arrow, text);
    current.append(total);
    return { direction, total, text };
  });

  const limitRow = element('div', 'traffic-limit');
  const hint = element('span', 'traffic-rule');
  const rule = element('button', 'traffic-rule-button');
  rule.type = 'button';
  rule.setAttribute('aria-expanded', 'false');
  const description = element('span', 'traffic-rule-description');
  description.setAttribute('aria-hidden', 'true');
  rule.addEventListener('click', () => {
    const open = rule.getAttribute('aria-expanded') !== 'true';
    hint.classList.toggle('is-dismissed', !open);
    rule.setAttribute('aria-expanded', String(open));
  });
  hint.addEventListener('pointerleave', () => hint.classList.remove('is-dismissed'));
  rule.addEventListener('blur', () => {
    hint.classList.remove('is-dismissed');
    rule.setAttribute('aria-expanded', 'false');
  });
  rule.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hint.classList.add('is-dismissed');
      rule.setAttribute('aria-expanded', 'false');
    }
  });
  hint.append(rule, description);

  const track = element('span', 'limit-track');
  const fill = element('span', 'limit-fill');
  track.append(fill);
  const usage = element('span', 'limit-text');
  limitRow.append(hint, track, usage);
  cell.append(current, limitRow);
  const chinese = /^zh(?:-|$)/i.test(navigator.language);

  return {
    cell,
    update(node: NodeState): void {
      const network = node.report?.network;
      for (const { direction, total, text } of totals) {
        const value = direction === 'up' ? network?.totalUp : network?.totalDown;
        const tone = !node.online ? 'danger' : typeof value === 'number' && value >= 0 ? 'ok' : 'muted';
        total.className = `direction ${direction} ${tone}`;
        text.textContent = formatTraffic(value);
      }
      const mode = node.metadata.trafficLimitType;
      const display = getTrafficPresentation(
        { up: network?.totalUp ?? null, down: network?.totalDown ?? null },
        node.metadata.trafficLimit,
        mode,
      );
      const empty = !display.limited || display.used === null;
      const tone = empty ? 'is-empty' : !node.online ? 'danger' : display.tone === 'warning' ? 'warn' : '';
      limitRow.className = `traffic-limit ${tone}`;
      rule.tabIndex = empty ? -1 : 0;
      const [icon, english, chineseLabel] = mode === 'sum' || mode === 'up' || mode === 'down' || mode === 'min'
        ? rules[mode] : rules.max;
      const label = chinese ? chineseLabel : english;
      if (rule.textContent !== icon) {
        rule.textContent = icon;
        rule.setAttribute('aria-label', label);
        description.textContent = label;
      }
      fill.style.width = `${display.ratio * 100}%`;
      usage.textContent = `${formatTraffic(display.used)} / ${formatTraffic(display.limit)}`;
    },
  };
}
