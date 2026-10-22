import { describe, expect, it } from 'vitest';
import { reconcileLiveSnapshot } from '../src/live';
import type { LiveReport } from '../src/domain';

function report(updatedAt: number | null, cpuUsage = 10): LiveReport {
  return {
    cpuUsage,
    ram: null,
    disk: null,
    network: null,
    updatedAt,
  };
}

describe('live snapshot reconciliation', () => {
  it('removes reports omitted by the next complete snapshot', () => {
    const result = reconcileLiveSnapshot(
      new Set(['node-a', 'node-b']),
      new Map([['node-a', report(100)], ['node-b', report(100)]]),
      { online: ['node-a'], data: { 'node-a': report(200) } },
      100,
    );

    expect(result).not.toBeNull();
    expect(result?.reports.has('node-b')).toBe(false);
    expect(result?.changedUuids).toEqual(new Set(['node-a', 'node-b']));
    expect(result?.onlineChangedUuids).toEqual(new Set(['node-b']));
  });

  it('ignores a late snapshot whose reports are older than the accepted state', () => {
    expect(reconcileLiveSnapshot(
      new Set(['node-a']),
      new Map([['node-a', report(300)]]),
      { online: ['node-a'], data: { 'node-a': report(200, 5) } },
      300,
    )).toBeNull();
  });

  it('keeps valid zero metrics distinct from unavailable fields', () => {
    const result = reconcileLiveSnapshot(
      new Set(),
      new Map(),
      {
        online: ['node-a'],
        data: {
          'node-a': {
            cpuUsage: 0,
            ram: { total: null, used: 0 },
            disk: null,
            network: { up: 0, down: null, totalUp: null, totalDown: 0 },
            updatedAt: 100,
          },
        },
      },
      null,
    );

    expect(result?.reports.get('node-a')).toMatchObject({
      cpuUsage: 0,
      ram: { total: null, used: 0 },
      network: { up: 0, down: null, totalUp: null, totalDown: 0 },
    });
  });
});
