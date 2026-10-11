import type { LatencyPoint, LatencySeries } from './domain';

export const LATENCY_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const;

export type LatencyTone = 'normal' | 'warning' | 'danger';

export type LatencySegment = {
  from: LatencyPoint;
  to: LatencyPoint;
  tone: LatencyTone;
};

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

export function latencyTone(value: number): LatencyTone {
  if (value < 100) {
    return 'normal';
  }
  if (value <= 200) {
    return 'warning';
  }
  return 'danger';
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
      const boundaries = [100, 200]
        .filter((threshold) => threshold > Math.min(lastPoint.value, point.value) && threshold < Math.max(lastPoint.value, point.value))
        .map((threshold) => ({
          timestamp: lastPoint.timestamp + ((threshold - lastPoint.value) / (point.value - lastPoint.value)) * (point.timestamp - lastPoint.timestamp),
          value: threshold,
        }));
      const splitPoints = [lastPoint, ...boundaries, point].sort((left, right) => left.timestamp - right.timestamp);
      for (let index = 1; index < splitPoints.length; index += 1) {
        const from = splitPoints[index - 1];
        const to = splitPoints[index];
        if (from && to) {
          segments.push({
            from,
            to,
            tone: latencyTone((from.value + to.value) / 2),
          });
        }
      }
    }
    previous = point;
  }
  return segments;
}

