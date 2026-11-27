/** Outage history covers the last 24h. */
export const STATUS_HISTORY_HOURS = 24;
/** Load records keep one-minute resolution only for windows up to 6h. */
export const STATUS_FINE_HOURS = 6;

const FINE_OUTAGE_MS = 3 * 60_000;
// Coarse (5-minute) records skip whole buckets around downsampling boundaries,
// so a gap must exceed three buckets before it counts as an outage.
const COARSE_OUTAGE_MS = 15 * 60_000;

export type OfflineInterval = {
  start: number;
  end: number;
  ongoing: boolean;
  /** The outage was already under way when the window began. */
  startClipped: boolean;
};

export type StatusHistoryInput = {
  /** Per-minute record times for the last 6h, or null when unavailable. */
  fineTimes: readonly number[] | null;
  /** Five-minute record times for the last 24h, or null when unavailable. */
  coarseTimes: readonly number[] | null;
  now: number;
  online: boolean;
  lastReportAt: number | null;
  createdAt: number | null;
};

type PreparedOutages = {
  at: number;
  nextBoundary: number;
  first: number | undefined;
  last: number | undefined;
  gaps: OfflineInterval[];
};

const WINDOW_MS = STATUS_HISTORY_HOURS * 3_600_000;
const FINE_WINDOW_MS = STATUS_FINE_HOURS * 3_600_000;

function prepareOutages(input: StatusHistoryInput): PreparedOutages {
  const { now, fineTimes, coarseTimes } = input;
  const windowStart = now - WINDOW_MS;
  const fineStart = fineTimes === null ? Infinity : now - FINE_WINDOW_MS;
  let nextBoundary = Infinity;
  const consider = (time: number): void => {
    if (time > now && time < nextBoundary) nextBoundary = time;
  };
  const visible = new Set<number>();
  for (const time of coarseTimes ?? []) {
    consider(time);
    consider(time + WINDOW_MS + 1);
    if (fineTimes !== null) consider(time + FINE_WINDOW_MS + 1);
    if (time >= windowStart && time <= now && time < fineStart) visible.add(time);
  }
  for (const time of fineTimes ?? []) {
    consider(time);
    consider(time + FINE_WINDOW_MS + 1);
    if (time >= fineStart && time <= now) visible.add(time);
  }
  const times = [...visible].sort((left, right) => left - right);
  const gaps: OfflineInterval[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const start = times[index - 1]!;
    const end = times[index]!;
    const threshold = start < fineStart ? COARSE_OUTAGE_MS : FINE_OUTAGE_MS;
    if (end - start > threshold) gaps.push({ start, end, ongoing: false, startClipped: false });
  }
  return { at: now, nextBoundary, first: times[0], last: times.at(-1), gaps };
}

function withCurrentEdges(input: StatusHistoryInput, prepared: PreparedOutages): OfflineInterval[] {
  const { now, online, createdAt, lastReportAt } = input;
  const windowStart = now - WINDOW_MS;
  const existsFrom = Math.max(windowStart, createdAt ?? windowStart);
  const { first, last, gaps } = prepared;
  const initialGap = first !== undefined && first - existsFrom > COARSE_OUTAGE_MS;
  if (!initialGap && online) return gaps;

  const intervals = [...gaps];
  if (initialGap) {
    intervals.unshift({ start: existsFrom, end: first, ongoing: false, startClipped: existsFrom === windowStart });
  }
  if (!online) {
    const start = lastReportAt ?? last ?? existsFrom;
    intervals.push({ start, end: now, ongoing: true, startClipped: lastReportAt === null && last === undefined });
  }
  return intervals;
}

/** Infer outages from gaps in the load records and the live online flag. */
export function buildOutages(input: StatusHistoryInput): OfflineInterval[] {
  return withCurrentEdges(input, prepareOutages(input));
}

/** Reuse completed outage gaps until the records or a rolling window boundary change. */
export function createOutageHistory(): (input: StatusHistoryInput) => OfflineInterval[] {
  let previous: PreparedOutages | null = null;
  let fineTimes: StatusHistoryInput['fineTimes'];
  let coarseTimes: StatusHistoryInput['coarseTimes'];

  return (input) => {
    if (!previous || fineTimes !== input.fineTimes || coarseTimes !== input.coarseTimes
      || input.now < previous.at || input.now >= previous.nextBoundary) {
      previous = prepareOutages(input);
      fineTimes = input.fineTimes;
      coarseTimes = input.coarseTimes;
    }
    return withCurrentEdges(input, previous);
  };
}
