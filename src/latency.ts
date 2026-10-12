import type { LatencyPoint, LatencySeries } from './domain';

export const LATENCY_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const;

// Fixed categorical slots validated against the #030805 terminal surface. Status
// colors remain reserved for node health and are deliberately not used here.
export const LATENCY_SERIES_COLORS = [
  '#3987e5',
  '#7046c7',
  '#a35229',
] as const;

export type LatencySegment = {
  from: LatencyPoint & { value: number };
  to: LatencyPoint & { value: number };
};

export type LatencyReadoutEntry = {
  taskId: string;
  label: string;
  value: number;
};

function seriesIndex(taskId: string): number {
  let hash = 0;
  for (const character of taskId) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A monitoring target keeps its color even if another range changes the order
 * or membership of the returned series.
 */
export function latencySeriesColor(taskId: string, _allTaskIds: readonly string[] = []): string {
  return LATENCY_SERIES_COLORS[seriesIndex(taskId) % LATENCY_SERIES_COLORS.length]!;
}

function nearestLatencyPoint(series: LatencySeries, timestamp: number): { timestamp: number; value: number } | null {
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

export function formatLatencyTimestamp(timestamp: number, rangeHours: number): string {
  const date = new Date(timestamp);
  if (rangeHours <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return `${date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

export function latencyReadoutEntries(
  timestamp: number,
  series: LatencySeries[],
  labels: Map<string, string>,
): LatencyReadoutEntry[] {
  const entries: LatencyReadoutEntry[] = [];
  for (const lineSeries of series) {
    const point = nearestLatencyPoint(lineSeries, timestamp);
    if (point) {
      entries.push({
        taskId: lineSeries.taskId,
        label: labels.get(lineSeries.taskId) ?? lineSeries.label,
        value: point.value,
      });
    }
  }
  return entries;
}

export function formatLatencyReadout(
  timestamp: number,
  series: LatencySeries[],
  labels: Map<string, string>,
  rangeHours: number,
): string {
  const values = [formatLatencyTimestamp(timestamp, rangeHours)];
  for (const entry of latencyReadoutEntries(timestamp, series, labels)) {
    values.push(`${entry.label} ${entry.value.toFixed(1)}ms`);
  }
  return values.join(' · ');
}

export function toggleVisibleTasks(
  allTaskIds: string[],
  visibleTaskIds: string[],
  taskId: string,
): string[] {
  const all = [...new Set(allTaskIds)];
  const visible = all.filter((id) => visibleTaskIds.includes(id));
  if (all.length === 0 || !all.includes(taskId)) {
    return visible;
  }
  if (visible.length === all.length) {
    return [taskId];
  }
  if (visible.length === 1 && visible[0] === taskId) {
    return all;
  }
  if (visible.includes(taskId)) {
    return visible.filter((id) => id !== taskId);
  }
  return [...visible, taskId].filter((id, index, values) => values.indexOf(id) === index);
}

export function filterLatencySeries(series: LatencySeries[], visibleTaskIds: string[]): LatencySeries[] {
  return series.filter((item) => visibleTaskIds.includes(item.taskId));
}

export function latencyCeiling(seriesOrPoints: LatencySeries[] | LatencyPoint[]): number {
  const points = Array.isArray(seriesOrPoints) && (seriesOrPoints.length === 0 || 'timestamp' in seriesOrPoints[0]!)
    ? seriesOrPoints as LatencyPoint[]
    : (seriesOrPoints as LatencySeries[]).flatMap((series) => series.points);
  const maximum = points.reduce((current, point) => {
    return typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0
      ? Math.max(current, point.value)
      : current;
  }, 0);
  return Math.max(300, Math.ceil(maximum / 100) * 100);
}

function validPoint(point: LatencyPoint): point is LatencyPoint & { value: number } {
  return Number.isFinite(point.timestamp)
    && typeof point.value === 'number'
    && Number.isFinite(point.value)
    && point.value >= 0;
}

export function buildLatencySegments(points: LatencyPoint[], sampleIntervalMs: number): LatencySegment[] {
  return buildLatencyRuns(points, sampleIntervalMs).flatMap((run) => {
    const segments: LatencySegment[] = [];
    for (let index = 1; index < run.length; index += 1) {
      const from = run[index - 1];
      const to = run[index];
      if (from && to) {
        segments.push({ from, to });
      }
    }
    return segments;
  });
}

/**
 * Returns point runs that may safely be drawn as a single SVG path. Missing,
 * invalid, duplicate, and over-large time gaps deliberately start a new run.
 */
export function buildLatencyRuns(
  points: LatencyPoint[],
  sampleIntervalMs: number,
): Array<Array<LatencyPoint & { value: number }>> {
  const sorted = [...points].sort((left, right) => left.timestamp - right.timestamp);
  const runs: Array<Array<LatencyPoint & { value: number }>> = [];
  let run: Array<LatencyPoint & { value: number }> = [];
  const maxGap = Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0
    ? sampleIntervalMs * 1.5
    : Number.POSITIVE_INFINITY;

  for (const point of sorted) {
    if (!validPoint(point)) {
      if (run.length > 1) {
        runs.push(run);
      }
      run = [];
      continue;
    }
    const previous = run.at(-1);
    if (previous && (point.timestamp <= previous.timestamp || point.timestamp - previous.timestamp > maxGap)) {
      if (run.length > 1) {
        runs.push(run);
      }
      run = [];
    }
    run.push(point);
  }
  if (run.length > 1) {
    runs.push(run);
  }
  return runs;
}

