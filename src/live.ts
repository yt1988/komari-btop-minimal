import type { LiveReport, LiveSnapshot } from './domain';

export type ReconciledLiveSnapshot = {
  online: Set<string>;
  reports: Map<string, LiveReport>;
  changedUuids: Set<string>;
  onlineChangedUuids: Set<string>;
  latestTimestamp: number | null;
};

function sameResource(
  left: LiveReport['ram'],
  right: LiveReport['ram'],
): boolean {
  return left?.total === right?.total && left?.used === right?.used;
}

function sameNetwork(
  left: LiveReport['network'],
  right: LiveReport['network'],
): boolean {
  return left?.up === right?.up
    && left?.down === right?.down
    && left?.totalUp === right?.totalUp
    && left?.totalDown === right?.totalDown;
}

export function liveReportChanged(
  previous: LiveReport | undefined,
  next: LiveReport | undefined,
): boolean {
  if (previous === undefined || next === undefined) {
    return previous !== next;
  }
  return previous.cpuUsage !== next.cpuUsage
    || !sameResource(previous.ram, next.ram)
    || !sameResource(previous.disk, next.disk)
    || !sameNetwork(previous.network, next.network)
    || previous.updatedAt !== next.updatedAt;
}

function latestReportTimestamp(snapshot: LiveSnapshot): number | null {
  let latest: number | null = null;
  for (const report of Object.values(snapshot.data)) {
    if (typeof report.updatedAt === 'number' && Number.isFinite(report.updatedAt)) {
      latest = latest === null ? report.updatedAt : Math.max(latest, report.updatedAt);
    }
  }
  return latest;
}

/**
 * Reconciles a complete `/api/clients` snapshot. A snapshot whose newest report
 * predates the last accepted snapshot is ignored, avoiding late WebSocket
 * responses rolling visible telemetry backwards.
 */
export function reconcileLiveSnapshot(
  previousOnline: ReadonlySet<string>,
  previousReports: ReadonlyMap<string, LiveReport>,
  snapshot: LiveSnapshot,
  lastSnapshotTimestamp: number | null,
): ReconciledLiveSnapshot | null {
  const latestTimestamp = latestReportTimestamp(snapshot);
  if (latestTimestamp !== null
    && lastSnapshotTimestamp !== null
    && latestTimestamp < lastSnapshotTimestamp) {
    return null;
  }

  const online = new Set(snapshot.online);
  const reports = new Map<string, LiveReport>();
  const changedUuids = new Set<string>();
  const onlineChangedUuids = new Set<string>();
  const uuids = new Set([
    ...previousOnline,
    ...online,
    ...previousReports.keys(),
    ...Object.keys(snapshot.data),
  ]);

  for (const uuid of uuids) {
    if (previousOnline.has(uuid) !== online.has(uuid)) {
      changedUuids.add(uuid);
      onlineChangedUuids.add(uuid);
    }

    const previous = previousReports.get(uuid);
    const next = snapshot.data[uuid];
    if (next !== undefined) {
      reports.set(uuid, next);
    }
    if (liveReportChanged(previous, next)) {
      changedUuids.add(uuid);
    }
  }

  return {
    online,
    reports,
    changedUuids,
    onlineChangedUuids,
    latestTimestamp,
  };
}
