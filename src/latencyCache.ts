import type { LatencyQuery } from './domain';

export type LatencyLoader = (uuid: string, hours: number) => Promise<LatencyQuery>;

export type LatencyCache = {
  /** A result younger than the cache's maximum age, with its age. */
  peek: (uuid: string, hours: number) => { query: LatencyQuery; ageMs: number } | null;
  /** Loads fresh data, sharing a request already in flight for the same node and range. */
  fetch: (uuid: string, hours: number) => Promise<LatencyQuery>;
  /** Warms the cache unless it already holds a result younger than `freshMs`. */
  prefetch: (uuid: string, hours: number, freshMs: number) => void;
};

/**
 * In-memory latency results per node and range, so range switches, returning
 * to a node and hover prefetches show data at once. Nothing is persisted, so
 * an old visit's data is never shown as current.
 */
export function createLatencyCache(
  load: LatencyLoader,
  options: { maxAgeMs?: number; maxEntries?: number; now?: () => number } = {},
): LatencyCache {
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 24;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { query: LatencyQuery; at: number }>();
  const inflight = new Map<string, Promise<LatencyQuery>>();
  const key = (uuid: string, hours: number): string => `${uuid}:${hours}`;

  const peek: LatencyCache['peek'] = (uuid, hours) => {
    const entry = entries.get(key(uuid, hours));
    const ageMs = entry ? now() - entry.at : Infinity;
    return entry && ageMs <= maxAgeMs ? { query: entry.query, ageMs } : null;
  };

  const fetch: LatencyCache['fetch'] = (uuid, hours) => {
    const id = key(uuid, hours);
    const pending = inflight.get(id);
    if (pending) {
      return pending;
    }
    const request = load(uuid, hours).then((query) => {
      entries.delete(id);
      entries.set(id, { query, at: now() });
      // Maps keep insertion order, so the first key is the least recently stored.
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
      return query;
    }).finally(() => {
      inflight.delete(id);
    });
    inflight.set(id, request);
    return request;
  };

  const prefetch: LatencyCache['prefetch'] = (uuid, hours, freshMs) => {
    const cached = peek(uuid, hours);
    if (!cached || cached.ageMs > freshMs) {
      fetch(uuid, hours).catch(() => undefined);
    }
  };

  return { peek, fetch, prefetch };
}
