import type { LatencyPoint, LatencyQuery, LatencySeries, PingTask } from './domain';

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

export type LatencyColorAssignment = ReadonlyMap<string, string>;

/**
 * Produces a unique color for every overlaid target. Task IDs are sorted before
 * allocation, so the result does not depend on API ordering or selected range.
 * Targets beyond the three comparison slots are deliberately returned separately.
 */
export function assignLatencyColors(taskIds: readonly string[]): {
  assignments: Map<string, string>;
  overflowTaskIds: string[];
} {
  const assignments = new Map<string, string>();
  const overflowTaskIds: string[] = [];
  for (const taskId of [...new Set(taskIds)].sort()) {
    const color = LATENCY_SERIES_COLORS[assignments.size];
    if (color) {
      assignments.set(taskId, color);
    } else {
      overflowTaskIds.push(taskId);
    }
  }
  return { assignments, overflowTaskIds };
}

export type LatencySegment = {
  from: LatencyPoint & { value: number };
  to: LatencyPoint & { value: number };
};

export type LatencyReadoutEntry = {
  taskId: string;
  label: string;
  value: number;
  loss: number | null;
};

/**
 * Komari records a lost probe as -1ms and averages it in. Given the bucket's
 * mean, standard deviation, probe count and loss share, this recovers the mean
 * and standard deviation of the probes that actually replied.
 */
export function correctLostProbes(
  mean: number | null,
  spread: number | null,
  samples: number | null,
  loss: number | null,
): { value: number | null; spread: number | null } {
  if (mean === null || samples === null || samples <= 0 || loss === null || loss <= 0) {
    return { value: mean, spread };
  }
  const lost = Math.round(loss * samples);
  const replied = samples - lost;
  if (replied <= 0) {
    return { value: null, spread: null };
  }
  const value = (mean * samples + lost) / replied;
  if (spread === null) {
    return { value, spread: null };
  }
  // Sum of squares over all probes, minus the lost probes' (-1)^2 each.
  const variance = ((spread * spread + mean * mean) * samples - lost) / replied - value * value;
  return { value, spread: Math.sqrt(Math.max(0, variance)) };
}

/**
 * Merges the per-bucket mean, standard deviation and loss queries into one
 * corrected series per target. Missing stddev or loss data degrades to the
 * plain mean.
 */
export function mergeLatencyQuality(
  average: LatencyQuery,
  deviation: LatencyQuery | null,
  loss: LatencyQuery | null,
): LatencyQuery {
  const lookup = (query: LatencyQuery | null, taskId: string): Map<number, LatencyPoint> =>
    new Map((query?.series.find((item) => item.taskId === taskId)?.points ?? []).map((point) => [point.timestamp, point]));
  return {
    ...average,
    series: average.series.map((series) => {
      const deviations = lookup(deviation, series.taskId);
      const losses = lookup(loss, series.taskId);
      return {
        ...series,
        points: series.points.map((point) => {
          const samples = point.samples ?? null;
          const lossShare = loss === null ? null : losses.get(point.timestamp)?.value ?? 0;
          const corrected = correctLostProbes(point.value, deviations.get(point.timestamp)?.value ?? null, samples, lossShare);
          return { timestamp: point.timestamp, ...corrected, loss: lossShare, samples };
        }),
      };
    }),
  };
}

export type LatencyStats = {
  /** Mean latency of replied probes over the range. */
  mean: number | null;
  /** Average within-bucket standard deviation, i.e. short-term jitter. */
  jitter: number | null;
  /** Lost share of all probes over the range, 0..1. */
  loss: number | null;
};

export function latencyStats(points: readonly LatencyPoint[]): LatencyStats {
  let replied = 0;
  let meanSum = 0;
  let spreadWeight = 0;
  let spreadSum = 0;
  let probes = 0;
  let lostSum = 0;
  for (const point of points) {
    const samples = point.samples ?? 1;
    if (typeof point.loss === 'number') {
      probes += samples;
      lostSum += point.loss * samples;
    }
    if (typeof point.value !== 'number' || point.value < 0) {
      continue;
    }
    const weight = samples * (1 - (point.loss ?? 0));
    replied += weight;
    meanSum += point.value * weight;
    if (typeof point.spread === 'number') {
      spreadWeight += weight;
      spreadSum += point.spread * weight;
    }
  }
  return {
    mean: replied > 0 ? meanSum / replied : null,
    jitter: spreadWeight > 0 ? spreadSum / spreadWeight : null,
    loss: probes > 0 ? lostSum / probes : null,
  };
}

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

function nearestLatencyPoint(series: LatencySeries, timestamp: number): LatencyPoint & { value: number } | null {
  let nearest: LatencyPoint & { value: number } | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const point of series.points) {
    if (typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0) {
      continue;
    }
    const candidateDistance = Math.abs(point.timestamp - timestamp);
    if (candidateDistance < distance) {
      nearest = point as LatencyPoint & { value: number };
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
        loss: point.loss ?? null,
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

/**
 * Resolves the latency targets shown for a node, keyed by task ID with display
 * labels. Once the ping task list is known it is authoritative, so history left
 * behind by a task that was unassigned from the node is not shown. Only when the
 * task list is unavailable are targets inferred from the returned series.
 */
export function resolveLatencyTargets(
  tasks: readonly PingTask[],
  tasksReady: boolean,
  uuid: string,
  series: readonly LatencySeries[],
): Map<string, string> {
  const targets = new Map(
    tasks.filter((task) => task.clients.includes(uuid)).map((task) => [task.id, task.name]),
  );
  if (!tasksReady) {
    for (const item of series) {
      if (!targets.has(item.taskId)) {
        targets.set(item.taskId, item.label);
      }
    }
  }
  return targets;
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
  const rough = Math.max(300, Math.ceil(maximum / 100) * 100);
  const step = latencyTickStep(rough);
  return Math.ceil(rough / step) * step;
}

const LATENCY_TICK_STEPS = [100, 200, 250, 500, 1000, 2000, 2500, 5000] as const;

function latencyTickStep(ceiling: number): number {
  return LATENCY_TICK_STEPS.find((step) => ceiling / step <= 5) ?? Math.ceil(ceiling / 5 / 1000) * 1000;
}

/** Evenly spaced axis values from 0 to a ceiling produced by `latencyCeiling`. */
export function latencyTicks(ceiling: number): number[] {
  const step = latencyTickStep(ceiling);
  const ticks: number[] = [];
  for (let value = 0; value <= ceiling; value += step) {
    ticks.push(value);
  }
  return ticks;
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
 * A run may hold a single isolated sample, which is drawn as a dot so that no
 * recorded value is invisible.
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
      if (run.length > 0) {
        runs.push(run);
      }
      run = [];
      continue;
    }
    const previous = run.at(-1);
    if (previous && (point.timestamp <= previous.timestamp || point.timestamp - previous.timestamp > maxGap)) {
      if (run.length > 0) {
        runs.push(run);
      }
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) {
    runs.push(run);
  }
  return runs;
}

