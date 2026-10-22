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

/**
 * Infers outages, oldest first, from gaps in the load records and the live
 * online flag. Precision is about one minute for the last 6h and five minutes
 * before that; an agent that stopped and a host that lost its network look
 * the same.
 */
export function buildOutages(input: StatusHistoryInput): OfflineInterval[] {
  const { now } = input;
  const windowStart = now - STATUS_HISTORY_HOURS * 3_600_000;
  const fineStart = input.fineTimes === null ? Infinity : now - STATUS_FINE_HOURS * 3_600_000;
  const times = [...new Set([
    ...(input.coarseTimes ?? []).filter((time) => time < fineStart),
    ...(input.fineTimes ?? []).filter((time) => time >= fineStart),
  ])]
    .filter((time) => time >= windowStart && time <= now)
    .sort((left, right) => left - right);
  const threshold = (from: number): number => (from < fineStart ? COARSE_OUTAGE_MS : FINE_OUTAGE_MS);

  const intervals: OfflineInterval[] = [];
  const existsFrom = Math.max(windowStart, input.createdAt ?? windowStart);
  const first = times[0];
  // A new node takes a few minutes to send its first report after creation.
  if (first !== undefined && first - existsFrom > COARSE_OUTAGE_MS) {
    intervals.push({ start: existsFrom, end: first, ongoing: false, startClipped: existsFrom === windowStart });
  }
  for (let index = 1; index < times.length; index += 1) {
    const start = times[index - 1]!;
    const end = times[index]!;
    if (end - start > threshold(start)) {
      intervals.push({ start, end, ongoing: false, startClipped: false });
    }
  }
  if (!input.online) {
    const start = input.lastReportAt ?? times.at(-1) ?? existsFrom;
    intervals.push({ start, end: now, ongoing: true, startClipped: input.lastReportAt === null && times.length === 0 });
  }
  return intervals;
}

export type StateSince = {
  since: number;
  /** The state began before the 24h window, so `since` is a lower bound. */
  atLeast: boolean;
};

/**
 * Start of the current state from report data alone: the ongoing outage start
 * when offline, otherwise the last recovery, otherwise the first record.
 */
export function currentStateSince(
  outages: readonly OfflineInterval[],
  online: boolean,
  input: Pick<StatusHistoryInput, 'fineTimes' | 'coarseTimes' | 'now' | 'createdAt'>,
): StateSince | null {
  if (!online) {
    const ongoing = outages.find((interval) => interval.ongoing);
    return ongoing ? { since: ongoing.start, atLeast: ongoing.startClipped } : null;
  }
  const recovered = outages.at(-1);
  if (recovered) {
    return { since: recovered.end, atLeast: false };
  }
  const windowStart = input.now - STATUS_HISTORY_HOURS * 3_600_000;
  const first = Math.min(...[...(input.coarseTimes ?? []), ...(input.fineTimes ?? [])].filter((time) => time >= windowStart));
  if (!Number.isFinite(first)) {
    return null;
  }
  // A leading gap would already be an outage, so only a node created inside
  // the window has a known start; otherwise it has been up the whole window.
  return input.createdAt !== null && input.createdAt > windowStart
    ? { since: first, atLeast: false }
    : { since: windowStart, atLeast: true };
}
