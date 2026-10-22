/** Load records keep one-minute resolution only for windows up to 6h. */
export const STATUS_HISTORY_HOURS = 6;

const MIN_OUTAGE_MS = 3 * 60_000;

export type OfflineInterval = {
  start: number;
  end: number;
  ongoing: boolean;
};

export type StatusHistory = {
  /** Oldest first. */
  intervals: OfflineInterval[];
  /** Latest agent boot inside the window, when known. */
  boot: number | null;
};

export type StatusHistoryInput = {
  recordTimes: readonly number[];
  now: number;
  online: boolean;
  lastReportAt: number | null;
  uptimeSeconds: number | null;
  hours?: number;
};

function medianStep(times: readonly number[]): number {
  const steps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    steps.push(times[index]! - times[index - 1]!);
  }
  steps.sort((left, right) => left - right);
  return steps[Math.floor(steps.length / 2)] ?? 60_000;
}

/**
 * Infers outages from gaps in the per-minute load records, the current online
 * flag, and the agent uptime. Precision is about one record interval; an agent
 * that stopped and a host that lost its network look the same.
 */
export function buildStatusHistory(input: StatusHistoryInput): StatusHistory {
  const { now } = input;
  const windowStart = now - (input.hours ?? STATUS_HISTORY_HOURS) * 3_600_000;
  const times = [...new Set(input.recordTimes)]
    .filter((time) => time >= windowStart && time <= now)
    .sort((left, right) => left - right);
  const threshold = Math.max(MIN_OUTAGE_MS, medianStep(times) * 3);

  const intervals: OfflineInterval[] = [];
  for (let index = 1; index < times.length; index += 1) {
    const start = times[index - 1]!;
    const end = times[index]!;
    if (end - start > threshold) {
      intervals.push({ start, end, ongoing: false });
    }
  }
  if (!input.online) {
    const lastSeen = Math.max(times.at(-1) ?? -Infinity, input.lastReportAt ?? -Infinity);
    intervals.push({ start: Number.isFinite(lastSeen) ? Math.max(lastSeen, windowStart) : windowStart, end: now, ongoing: true });
  }

  // The last report's uptime still dates the latest boot after the node goes offline.
  const firstSeen = times[0] ?? windowStart;
  const boot = input.uptimeSeconds !== null && input.uptimeSeconds >= 0
    ? (input.lastReportAt ?? now) - input.uptimeSeconds * 1000
    : null;
  return { intervals, boot: boot !== null && boot > firstSeen ? boot : null };
}

/** The ongoing outage start when offline, otherwise the boot time when known. */
export function currentStateSince(history: StatusHistory | null, online: boolean, lastReportAt: number | null, uptimeSeconds: number | null, now: number): number | null {
  if (!online) {
    return history?.intervals.find((interval) => interval.ongoing)?.start ?? lastReportAt;
  }
  return uptimeSeconds !== null && uptimeSeconds >= 0 ? (lastReportAt ?? now) - uptimeSeconds * 1000 : null;
}
