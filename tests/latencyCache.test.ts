import { describe, expect, it } from 'vitest';
import type { LatencyQuery } from '../src/domain';
import { createLatencyCache } from '../src/latencyCache';

const query = (start: number): LatencyQuery => ({ start, end: start + 1, intervalSeconds: 300, series: [] });

describe('latency cache', () => {
  it('shares one request between a prefetch and the page that follows it', async () => {
    let calls = 0;
    let release: (value: LatencyQuery) => void = () => undefined;
    const cache = createLatencyCache(() => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    });
    cache.prefetch('node', 24, 60_000);
    const page = cache.fetch('node', 24);
    release(query(1));
    expect(await page).toEqual(query(1));
    expect(calls).toBe(1);
  });

  it('serves results until they age out, then reloads', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createLatencyCache(async () => query(++calls), { maxAgeMs: 300_000, now: () => clock });
    await cache.fetch('node', 24);
    clock = 30_000;
    expect(cache.peek('node', 24)).toEqual({ query: query(1), ageMs: 30_000 });
    cache.prefetch('node', 24, 60_000);
    expect(calls).toBe(1);
    clock = 301_000;
    expect(cache.peek('node', 24)).toBeNull();
    await cache.fetch('node', 24);
    expect(calls).toBe(2);
  });

  it('keeps ranges apart and evicts the oldest entries', async () => {
    const cache = createLatencyCache(async (uuid, hours) => query(hours), { maxEntries: 2 });
    await cache.fetch('node', 1);
    await cache.fetch('node', 24);
    await cache.fetch('node', 168);
    expect(cache.peek('node', 1)).toBeNull();
    expect(cache.peek('node', 24)?.query).toEqual(query(24));
    expect(cache.peek('node', 168)?.query).toEqual(query(168));
  });

  it('does not cache failures', async () => {
    let fail = true;
    const cache = createLatencyCache(async () => {
      if (fail) {
        throw new Error('down');
      }
      return query(2);
    });
    await expect(cache.fetch('node', 24)).rejects.toThrow('down');
    expect(cache.peek('node', 24)).toBeNull();
    fail = false;
    expect(await cache.fetch('node', 24)).toEqual(query(2));
  });
});
