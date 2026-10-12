import type { LatencyPoint, LatencySeries } from './domain';

export const LATENCY_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const;

export const LATENCY_SERIES_COLORS = [
  '#20b8ff',
  '#a8e600',
  '#ffb347',
  '#ff6b8a',
  '#b58cff',
  '#35f477',
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

export function latencySeriesColor(taskId: string, allTaskIds: readonly string[]): string {
  const index = allTaskIds.indexOf(taskId);
  if (index >= 0) {
    return LATENCY_SERIES_COLORS[index % LATENCY_SERIES_COLORS.length]!;
  }
  let hash = 0;
  for (const character of taskId) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return LATENCY_SERIES_COLORS[Math.abs(hash) % LATENCY_SERIES_COLORS.length]!;
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
  const sorted = [...points].sort((left, right) => left.timestamp - right.timestamp);
  const segments: LatencySegment[] = [];
  let previous: (LatencyPoint & { value: number }) | null = null;
  const maxGap = Number.isFinite(sampleIntervalMs) && sampleIntervalMs > 0 ? sampleIntervalMs * 1.5 : Number.POSITIVE_INFINITY;
  for (const point of sorted) {
    if (!validPoint(point)) {
      previous = null;
      continue;
    }
    const lastPoint = previous;
    if (lastPoint !== null && point.timestamp > lastPoint.timestamp && point.timestamp - lastPoint.timestamp <= maxGap) {
      segments.push({ from: lastPoint, to: point });
    }
    previous = point;
  }
  return segments;
}

