import { formatLoss } from '../format';
import type { LatencyQuery, LatencySeries } from '../domain';
import {
  buildLatencyRuns,
  formatLatencyTimestamp,
  latencyCeiling,
  latencyTicks,
  latencyReadoutEntries,
  latencySeriesColor,
} from '../latency';
import type { LatencyColorAssignment } from '../latencyColors';
import type { OfflineInterval } from '../statusHistory';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tag);
}

function nearestPoint(series: LatencySeries, timestamp: number): { timestamp: number; value: number } | null {
  let nearest: { timestamp: number; value: number } | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of series.points) {
    if (typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0) {
      continue;
    }
    const candidateDistance = Math.abs(point.timestamp - timestamp);
    if (candidateDistance < distance) {
      nearest = point as { timestamp: number; value: number };
      distance = candidateDistance;
    }
  }
  return nearest;
}

export type LatencyChartOptions = {
  query: LatencyQuery | null;
  visibleTaskIds: string[];
  allTaskIds: string[];
  colorAssignments: LatencyColorAssignment;
  labels: Map<string, string>;
  rangeHours: number;
  offline?: readonly OfflineInterval[];
  /** Targets that get a loss lane, hidden ones included so the height never changes. */
  laneTaskIds?: readonly string[];
};

const LANE_HEIGHT = 5;
const LANE_GAP = 4;

export function renderLatencyChart(container: HTMLElement, options: LatencyChartOptions): void {
  container.replaceChildren();
  const series = (options.query?.series ?? []).filter((item) => options.visibleTaskIds.includes(item.taskId));
  const points = series.flatMap((item) => item.points);
  if (points.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-message muted';
    empty.textContent = 'no latency records';
    container.append(empty);
    return;
  }

  const earliest = points.reduce((value, point) => Math.min(value, point.timestamp), Number.POSITIVE_INFINITY);
  const latest = points.reduce((value, point) => Math.max(value, point.timestamp), Number.NEGATIVE_INFINITY);
  const start = options.query?.start || earliest;
  const end = options.query?.end || latest;
  const timeSpan = Math.max(1, end - start);
  // The ceiling leaves room for the top of each spread band.
  const ceiling = latencyCeiling(points.map((point) => ({
    ...point,
    value: point.value === null ? null : point.value + (point.spread ?? 0),
  })));
  const ticks = latencyTicks(ceiling);
  const toX = (timestamp: number): number => (timestamp - start) / timeSpan * 1000;
  const toY = (value: number): number => 280 - Math.min(ceiling, value) / ceiling * 280;
  const stage = document.createElement('div');
  stage.className = 'graph-wrap';

  const graphArea = document.createElement('div');
  graphArea.className = 'graph-area';
  const plot = document.createElement('div');
  plot.className = 'graph-plot';
  const axis = document.createElement('div');
  axis.className = 'axis-y';
  ticks.forEach((value) => {
    const label = document.createElement('span');
    label.textContent = value === 0 ? '0' : `${value}ms`;
    label.style.top = `${toY(value) / 280 * 100}%`;
    axis.append(label);
  });
  const graph = svgElement('svg');
  graph.classList.add('graph');
  graph.setAttribute('viewBox', '0 0 1000 280');
  graph.setAttribute('preserveAspectRatio', 'none');
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', 'Latency chart');
  const description = svgElement('desc');
  description.textContent = 'Each latency target uses a stable dedicated color.';
  graph.append(description);

  const grid = svgElement('g');
  grid.classList.add('graph-grid');
  ticks.forEach((value) => {
    const line = svgElement('line');
    const y = toY(value);
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '1000');
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    grid.append(line);
  });
  graph.append(grid);

  const offline = (options.offline ?? []).filter((interval) => interval.end > start && interval.start < end);
  for (const interval of offline) {
    const band = svgElement('rect');
    band.classList.add('offline-band');
    const x = toX(Math.max(start, interval.start));
    band.setAttribute('x', x.toFixed(3));
    band.setAttribute('y', '0');
    band.setAttribute('width', Math.max(1, toX(Math.min(end, interval.end)) - x).toFixed(3));
    band.setAttribute('height', '280');
    graph.append(band);
  }

  const crosshair = svgElement('line');
  crosshair.classList.add('cross');
  crosshair.setAttribute('x1', '0');
  crosshair.setAttribute('x2', '0');
  crosshair.setAttribute('y1', '0');
  crosshair.setAttribute('y2', '280');
  crosshair.style.visibility = 'hidden';
  graph.append(crosshair);

  // The SVG stretches non-uniformly, so dots are zero-length round-capped paths
  // with non-scaling strokes rather than circles, which would render as ellipses.
  const dotPath = (x: number, y: number): string => `M ${x.toFixed(3)} ${y.toFixed(3)} l 0 0`;
  const markers = new Map<string, SVGPathElement>();
  const colorOf = (taskId: string): string => options.colorAssignments.get(taskId) ?? latencySeriesColor(taskId, options.allTaskIds);
  const sampleInterval = options.query?.intervalSeconds && options.query.intervalSeconds > 0
    ? options.query.intervalSeconds * 1000
    : Math.max(1, options.rangeHours * 60 / 480) * 60_000;
  series.forEach((lineSeries) => {
    const color = colorOf(lineSeries.taskId);
    const group = svgElement('g');
    group.setAttribute('aria-label', options.labels.get(lineSeries.taskId) ?? lineSeries.label);
    for (const run of buildLatencyRuns(lineSeries.points, sampleInterval)) {
      const first = run[0];
      if (!first) {
        continue;
      }
      // Smokeping-style band: mean ± one standard deviation of the replied probes.
      if (run.length > 1 && run.every((point) => typeof point.spread === 'number')) {
        const upper = run.map((point) => `${toX(point.timestamp).toFixed(3)},${toY(point.value + point.spread!).toFixed(3)}`);
        const lower = run.map((point) => `${toX(point.timestamp).toFixed(3)},${toY(Math.max(0, point.value - point.spread!)).toFixed(3)}`).reverse();
        const band = svgElement('polygon');
        band.classList.add('latency-band');
        band.style.fill = color;
        band.setAttribute('points', [...upper, ...lower].join(' '));
        group.append(band);
      }
      const path = svgElement('path');
      path.style.stroke = color;
      if (run.length === 1) {
        path.classList.add('latency-dot');
        path.setAttribute('d', dotPath(toX(first.timestamp), toY(first.value)));
      } else {
        path.classList.add('latency-segment');
        const commands = [`M ${toX(first.timestamp).toFixed(3)} ${toY(first.value).toFixed(3)}`];
        for (const point of run.slice(1)) {
          commands.push(`L ${toX(point.timestamp).toFixed(3)} ${toY(point.value).toFixed(3)}`);
        }
        path.setAttribute('d', commands.join(' '));
      }
      group.append(path);
    }
    const marker = svgElement('path');
    marker.classList.add('point');
    marker.style.stroke = color;
    marker.style.visibility = 'hidden';
    graph.append(group, marker);
    markers.set(lineSeries.taskId, marker);
  });
  plot.append(axis, graph);
  graphArea.append(plot);

  // One loss lane per target, in legend order. Loss is drawn in the target's own
  // color, brighter with more loss; hidden targets keep a dimmed lane.
  const laneTaskIds = options.laneTaskIds ?? series.map((item) => item.taskId);
  if (laneTaskIds.length > 0) {
    const lanes = document.createElement('div');
    lanes.className = 'loss-lanes';
    lanes.setAttribute('aria-hidden', 'true');
    const laneHeight = laneTaskIds.length * (LANE_HEIGHT + LANE_GAP) - LANE_GAP;
    const laneSvg = svgElement('svg');
    laneSvg.setAttribute('viewBox', `0 0 1000 ${laneHeight}`);
    laneSvg.setAttribute('preserveAspectRatio', 'none');
    laneSvg.style.height = `${laneHeight}px`;
    const bucketWidth = Math.max(0.5, sampleInterval / timeSpan * 1000);
    laneTaskIds.forEach((taskId, row) => {
      const y = row * (LANE_HEIGHT + LANE_GAP);
      const color = colorOf(taskId);
      const lane = svgElement('g');
      if (!options.visibleTaskIds.includes(taskId)) {
        lane.classList.add('is-hidden');
      }
      const track = svgElement('rect');
      track.classList.add('loss-track');
      track.setAttribute('x', '0');
      track.setAttribute('y', String(y));
      track.setAttribute('width', '1000');
      track.setAttribute('height', String(LANE_HEIGHT));
      lane.append(track);
      for (const point of options.query?.series.find((item) => item.taskId === taskId)?.points ?? []) {
        if (typeof point.loss !== 'number' || point.loss <= 0) {
          continue;
        }
        const cell = svgElement('rect');
        cell.setAttribute('x', (toX(point.timestamp) - bucketWidth / 2).toFixed(3));
        cell.setAttribute('y', String(y));
        cell.setAttribute('width', bucketWidth.toFixed(3));
        cell.setAttribute('height', String(LANE_HEIGHT));
        cell.style.fill = color;
        cell.style.fillOpacity = Math.min(1, 0.3 + point.loss * 1.6).toFixed(2);
        lane.append(cell);
      }
      laneSvg.append(lane);
    });
    lanes.append(laneSvg);
    graphArea.append(lanes);
  }

  const xAxis = document.createElement('div');
  xAxis.className = 'axis-x';
  for (let index = 0; index < 4; index += 1) {
    const label = document.createElement('span');
    label.textContent = formatLatencyTimestamp(start + timeSpan * index / 3, options.rangeHours);
    xAxis.append(label);
  }
  graphArea.append(xAxis);
  stage.append(graphArea);
  container.append(stage);

  const readout = document.createElement('div');
  readout.className = 'chart-readout';
  readout.hidden = true;
  graphArea.append(readout);

  const clearInspection = (): void => {
    crosshair.style.visibility = 'hidden';
    markers.forEach((marker) => {
      marker.style.visibility = 'hidden';
    });
    readout.hidden = true;
  };

  const inspectTimestamp = (timestamp: number): void => {
    graph.dataset.inspectedTimestamp = String(timestamp);
    const ratio = Math.max(0, Math.min(1, (timestamp - start) / timeSpan));
    const x = ratio * 1000;
    crosshair.setAttribute('x1', String(x));
    crosshair.setAttribute('x2', String(x));
    crosshair.style.visibility = 'visible';
    const entries = latencyReadoutEntries(timestamp, series, options.labels);
    series.forEach((lineSeries) => {
      const marker = markers.get(lineSeries.taskId);
      const point = nearestPoint(lineSeries, timestamp);
      if (!marker) {
        return;
      }
      if (!point) {
        marker.style.visibility = 'hidden';
        return;
      }
      marker.setAttribute('d', dotPath(toX(point.timestamp), toY(point.value)));
      marker.style.visibility = 'visible';
    });
    readout.replaceChildren();
    const timestampLabel = document.createElement('span');
    timestampLabel.className = 'chart-readout-time';
    timestampLabel.textContent = formatLatencyTimestamp(timestamp, options.rangeHours);
    readout.append(timestampLabel);
    if (offline.some((interval) => timestamp >= interval.start && timestamp <= interval.end)) {
      const down = document.createElement('span');
      down.className = 'danger';
      down.textContent = 'down';
      readout.append(document.createTextNode(' · '), down);
    }
    entries.forEach((entry) => {
      const separator = document.createTextNode(' · ');
      const value = document.createElement('span');
      value.className = 'chart-readout-item';
      const swatch = document.createElement('span');
      swatch.className = 'chart-readout-swatch';
      swatch.style.backgroundColor = options.colorAssignments.get(entry.taskId) ?? latencySeriesColor(entry.taskId, options.allTaskIds);
      swatch.setAttribute('aria-hidden', 'true');
      value.append(swatch, document.createTextNode(`${entry.label} ${entry.value.toFixed(1)}ms`));
      if (entry.loss !== null && entry.loss > 0) {
        value.append(document.createTextNode(` ${formatLoss(entry.loss)}`));
      }
      readout.append(separator, value);
    });
    readout.style.left = `${ratio * 100}%`;
    readout.hidden = false;
  };

  const inspectPointer = (event: PointerEvent): void => {
    const bounds = graph.getBoundingClientRect();
    if (bounds.width <= 0) {
      return;
    }
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    inspectTimestamp(start + ratio * timeSpan);
  };

  graph.addEventListener('pointerdown', (event) => {
    graph.setPointerCapture?.(event.pointerId);
    inspectPointer(event);
  });
  graph.addEventListener('pointermove', inspectPointer);
  graph.addEventListener('pointerup', (event) => {
    if (graph.hasPointerCapture?.(event.pointerId)) {
      graph.releasePointerCapture(event.pointerId);
    }
  });
  graph.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') {
      clearInspection();
    }
  });
}

