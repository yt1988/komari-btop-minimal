import type { LatencyQuery, LatencySeries } from '../domain';
import {
  buildLatencySegments,
  formatLatencyTimestamp,
  latencyCeiling,
  latencyReadoutEntries,
  latencySeriesColor,
  latencySeriesDash,
} from '../latency';

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
  labels: Map<string, string>;
  rangeHours: number;
};

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
  const ceiling = latencyCeiling(points);
  const stage = document.createElement('div');
  stage.className = 'graph-wrap';
  const axis = document.createElement('div');
  axis.className = 'axis-y';
  [ceiling, 200, 100, 0].forEach((value) => {
    const label = document.createElement('span');
    label.textContent = value === 0 ? '0' : `${value}ms`;
    axis.append(label);
  });
  stage.append(axis);

  const graphArea = document.createElement('div');
  graphArea.className = 'graph-area';
  const graph = svgElement('svg');
  graph.classList.add('graph');
  graph.setAttribute('viewBox', '0 0 1000 280');
  graph.setAttribute('preserveAspectRatio', 'none');
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', 'Latency chart');
  const description = svgElement('desc');
  description.textContent = 'Each latency target uses a distinct color and line pattern.';
  graph.append(description);

  const grid = svgElement('g');
  grid.classList.add('graph-grid');
  [0, 100, 200, ceiling].forEach((value) => {
    const line = svgElement('line');
    const y = 280 - Math.min(ceiling, value) / ceiling * 280;
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '1000');
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    grid.append(line);
  });
  graph.append(grid);

  const crosshair = svgElement('line');
  crosshair.classList.add('cross');
  crosshair.setAttribute('x1', '0');
  crosshair.setAttribute('x2', '0');
  crosshair.setAttribute('y1', '0');
  crosshair.setAttribute('y2', '280');
  crosshair.style.visibility = 'hidden';
  graph.append(crosshair);

  const markers = new Map<string, SVGCircleElement>();
  series.forEach((lineSeries) => {
    const color = latencySeriesColor(lineSeries.taskId, options.allTaskIds);
    const group = svgElement('g');
    group.setAttribute('aria-label', options.labels.get(lineSeries.taskId) ?? lineSeries.label);
    const sampleInterval = options.query?.intervalSeconds && options.query.intervalSeconds > 0
      ? options.query.intervalSeconds * 1000
      : Math.max(1, options.rangeHours * 60 / 480) * 60_000;
    for (const segment of buildLatencySegments(lineSeries.points, sampleInterval)) {
      const line = svgElement('line');
      line.classList.add('latency-segment');
      line.style.stroke = color;
      const dash = latencySeriesDash(lineSeries.taskId, options.allTaskIds);
      if (dash !== 'none') {
        line.setAttribute('stroke-dasharray', dash);
      }
      line.setAttribute('x1', String((segment.from.timestamp - start) / timeSpan * 1000));
      line.setAttribute('x2', String((segment.to.timestamp - start) / timeSpan * 1000));
      line.setAttribute('y1', String(280 - segment.from.value! / ceiling * 280));
      line.setAttribute('y2', String(280 - segment.to.value! / ceiling * 280));
      group.append(line);
    }
    const marker = svgElement('circle');
    marker.classList.add('point');
    marker.style.fill = color;
    marker.setAttribute('r', '3');
    marker.style.visibility = 'hidden';
    graph.append(group, marker);
    markers.set(lineSeries.taskId, marker);
  });
  graphArea.append(graph);

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
      marker.setAttribute('cx', String((point.timestamp - start) / timeSpan * 1000));
      marker.setAttribute('cy', String(280 - point.value / ceiling * 280));
      marker.style.visibility = 'visible';
    });
    readout.replaceChildren();
    const timestampLabel = document.createElement('span');
    timestampLabel.className = 'chart-readout-time';
    timestampLabel.textContent = formatLatencyTimestamp(timestamp, options.rangeHours);
    readout.append(timestampLabel);
    entries.forEach((entry) => {
      const separator = document.createTextNode(' · ');
      const value = document.createElement('span');
      value.className = 'chart-readout-item';
      value.style.color = latencySeriesColor(entry.taskId, options.allTaskIds);
      value.textContent = `${entry.label} ${entry.value.toFixed(1)}ms`;
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

