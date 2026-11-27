import type {
  LatencyQuery,
  LiveReport,
  LiveSnapshot,
  NodeMetadata,
  PingTask,
  ResourceMetric,
} from '../domain';
import { mergeLatencyQuality } from '../latency';

type JsonObject = Record<string, unknown>;

export type PublicSettings = {
  siteName: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, endpoint: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${endpoint}: expected an object`);
  }
  return value;
}

function asArray(value: unknown, endpoint: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${endpoint}: expected an array`);
  }
  return value;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringId(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordValue(record: JsonObject, key: string): JsonObject {
  return isObject(record[key]) ? record[key] : {};
}

export function unwrapStandardResponse(raw: unknown, endpoint: string): unknown {
  const response = asObject(raw, endpoint);
  if (response.status !== 'success') {
    const message = asString(response.message, asString(response.error, 'request failed'));
    throw new Error(`${endpoint}: ${message}`);
  }
  if (!('data' in response)) {
    throw new Error(`${endpoint}: missing data`);
  }
  return response.data;
}

function unwrapRpcResponse(raw: unknown, endpoint: string): unknown {
  const response = asObject(raw, endpoint);
  if ('error' in response && response.error != null) {
    const error = isObject(response.error) ? asString(response.error.message, 'RPC request failed') : 'RPC request failed';
    throw new Error(`${endpoint}: ${error}`);
  }
  if ('result' in response) {
    return response.result;
  }
  return unwrapStandardResponse(response, endpoint);
}

export function parseNodeMetadata(raw: unknown): NodeMetadata[] {
  const items = asArray(unwrapStandardResponse(raw, '/api/nodes'), '/api/nodes');
  return items.map((item) => {
    const node = asObject(item, '/api/nodes');
    const uuid = asStringId(node.uuid);
    if (!uuid) {
      throw new Error('/api/nodes: node is missing uuid');
    }
    return {
      uuid,
      name: asString(node.name, uuid),
      group: asString(node.group),
      region: asString(node.region),
      weight: asFiniteNumber(node.weight),
      memTotal: asFiniteNumber(node.mem_total),
      diskTotal: asFiniteNumber(node.disk_total),
      trafficLimit: asFiniteNumber(node.traffic_limit),
      trafficLimitType: asString(node.traffic_limit_type, 'max'),
      createdAt: parseTimestamp(node.created_at),
    };
  }).sort((left, right) => left.weight - right.weight);
}

export function parsePublicSettings(raw: unknown): PublicSettings {
  const settings = asObject(unwrapStandardResponse(raw, '/api/public'), '/api/public');
  const siteName = asString(settings.sitename).trim();
  return { siteName: siteName || 'Komari' };
}

export function parsePingTasks(raw: unknown): PingTask[] {
  const items = asArray(unwrapStandardResponse(raw, '/api/task/ping'), '/api/task/ping');
  return items.flatMap((item) => {
    const task = asObject(item, '/api/task/ping');
    const id = asStringId(task.id);
    if (!id) {
      return [];
    }
    const clients = Array.isArray(task.clients)
      ? task.clients.map((client) => asStringId(client)).filter(Boolean)
      : [];
    return [{
      id,
      name: asString(task.name, id),
      clients,
      defaultOn: task.default_on === true,
      type: asString(task.type),
      interval: asFiniteNumber(task.interval, 60),
    }];
  });
}

function parseLiveReport(raw: unknown): LiveReport {
  const report = asObject(raw, '/api/clients');
  const cpu = recordValue(report, 'cpu');
  const ram = recordValue(report, 'ram');
  const disk = recordValue(report, 'disk');
  const network = recordValue(report, 'network');
  const resource = (source: JsonObject): { total: number | null; used: number | null } | null => {
    const total = asNullableNumber(source.total);
    const used = asNullableNumber(source.used);
    return total === null && used === null ? null : { total, used };
  };
  const networkValue = [network.up, network.down, network.totalUp, network.totalDown]
    .some((value) => typeof value === 'number' && Number.isFinite(value))
    ? {
      up: asNullableNumber(network.up),
      down: asNullableNumber(network.down),
      totalUp: asNullableNumber(network.totalUp),
      totalDown: asNullableNumber(network.totalDown),
    }
    : null;
  return {
    cpuUsage: asNullableNumber(cpu.usage),
    ram: resource(ram),
    disk: resource(disk),
    network: networkValue,
    updatedAt: parseTimestamp(report.updated_at),
  };
}

/** Timestamps of the per-node load records; gaps between them mark outages. */
export function parseLoadRecordTimes(raw: unknown): number[] {
  const data = asObject(unwrapStandardResponse(raw, '/api/records/load'), '/api/records/load');
  const records = Array.isArray(data.records) ? data.records : [];
  return records
    .map((record) => (isObject(record) ? parseTimestamp(record.time) : null))
    .filter((timestamp): timestamp is number => timestamp !== null)
    .sort((left, right) => left - right);
}

export function parseLiveSnapshot(raw: unknown): LiveSnapshot {
  const data = asObject(unwrapStandardResponse(raw, '/api/clients'), '/api/clients');
  const online = Array.isArray(data.online) ? data.online.map((uuid) => asStringId(uuid)).filter(Boolean) : [];
  const reports = asObject(data.data ?? {}, '/api/clients');
  const normalized: Record<string, LiveReport> = {};
  for (const [uuid, report] of Object.entries(reports)) {
    if (uuid) {
      normalized[uuid] = parseLiveReport(report);
    }
  }
  return { online, data: normalized };
}

export function parseLatencyQuery(raw: unknown, kind: 'latency' | 'resource' = 'latency'): LatencyQuery {
  const data = asObject(unwrapRpcResponse(raw, '/api/rpc2'), '/api/rpc2');
  const rawSeries = asArray(data.series, '/api/rpc2');
  const defaultInterval = asFiniteNumber(data.interval_seconds);
  let intervalSeconds = defaultInterval;
  const series = rawSeries.map((item, index) => {
    const source = asObject(item, '/api/rpc2');
    const seriesInterval = asFiniteNumber(source.interval_seconds, defaultInterval);
    if (intervalSeconds <= 0) {
      intervalSeconds = seriesInterval;
    }
    const tags = recordValue(source, 'tags');
    const taskId = (kind === 'resource' ? asString(source.metric_key) : asStringId(tags.task_id) || asStringId(source.task_id))
      || `series-${index + 1}`;
    const points = asArray(source.points, '/api/rpc2').map((point) => {
      const value = asObject(point, '/api/rpc2');
      const timestamp = parseTimestamp(value.time ?? value.timestamp);
      if (timestamp === null) {
        throw new Error('/api/rpc2: latency point is missing time');
      }
      const samples = asNullableNumber(value.count);
      return samples === null
        ? { timestamp, value: asNullableNumber(value.value) }
        : { timestamp, value: asNullableNumber(value.value), samples };
    });
    return {
      taskId,
      label: asString(tags.task_name, asString(source.name, taskId)),
      ...(seriesInterval > 0 ? { intervalSeconds: seriesInterval } : {}),
      points,
    };
  });
  const start = parseTimestamp(data.start) ?? 0;
  const end = parseTimestamp(data.end) ?? 0;
  return {
    start,
    end,
    intervalSeconds,
    series,
  };
}

export class KomariHttpError extends Error {
  constructor(path: string, readonly status: number) {
    super(`${path}: HTTP ${status}`);
  }
}

export function isAccessDenied(error: unknown): boolean {
  return error instanceof KomariHttpError && (error.status === 401 || error.status === 403);
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const parent = init?.signal;
  const abort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 15_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const { signal } = controller;
      const cancel = (): void => reject(signal.reason);
      if (signal.aborted) {
        cancel();
        return;
      }
      // Settle the caller even if a stalled WebKit fetch has not acknowledged the abort.
      signal.addEventListener('abort', cancel, { once: true });
      void fetch(path, { ...init, signal }).then((response) => {
        if (!response.ok) throw new KomariHttpError(path, response.status);
        return response.json() as Promise<unknown>;
      }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}

export async function fetchNodeMetadata(signal?: AbortSignal): Promise<NodeMetadata[]> {
  return parseNodeMetadata(await fetchJson('/api/nodes', { signal, cache: 'no-store' }));
}

export async function fetchPublicSettings(signal?: AbortSignal): Promise<PublicSettings> {
  return parsePublicSettings(await fetchJson('/api/public', { signal }));
}

export async function fetchPingTasks(signal?: AbortSignal): Promise<PingTask[]> {
  return parsePingTasks(await fetchJson('/api/task/ping', { signal }));
}

export async function fetchLoadRecordTimes(uuid: string, hours: number, signal?: AbortSignal): Promise<number[]> {
  const query = new URLSearchParams({ uuid, hours: String(hours) });
  return parseLoadRecordTimes(await fetchJson(`/api/records/load?${query}`, { signal }));
}

async function queryMetrics(
  uuid: string,
  hours: number,
  metrics: { metric_key: string } | { metric_keys: readonly string[] },
  aggregation: 'avg' | 'stddev',
  signal?: AbortSignal,
): Promise<unknown> {
  return fetchJson('/api/rpc2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${'metric_key' in metrics ? metrics.metric_key : metrics.metric_keys.join(',')}-${aggregation}-${uuid}-${hours}`,
      method: 'public:queryMetrics',
      params: {
        ...metrics,
        entity_id: uuid,
        hours,
        max_points: 480,
        aggregation,
        fill_empty: false,
      },
    }),
  });
}

export async function fetchResourceHistory(uuid: string, hours: number, metric: ResourceMetric, signal?: AbortSignal): Promise<LatencyQuery> {
  const keys = {
    cpu: ['cpu.usage'],
    mem: ['memory.used'],
    network: ['net.in.rate', 'net.out.rate'],
  }[metric];
  return parseLatencyQuery(await queryMetrics(uuid, hours, { metric_keys: keys }, 'avg', signal), 'resource');
}

/**
 * Per-bucket latency with lost probes excluded, plus spread and loss. The
 * stddev and loss queries are optional; without them the plain mean is shown.
 */
export async function fetchLatency(uuid: string, hours: number, signal?: AbortSignal): Promise<LatencyQuery> {
  const optional = (query: Promise<LatencyQuery>): Promise<LatencyQuery | null> => query.catch((error: unknown) => {
    if (signal?.aborted || isAccessDenied(error)) {
      throw error;
    }
    return null;
  });
  const [average, deviation, loss] = await Promise.all([
    queryMetrics(uuid, hours, { metric_key: 'ping.latency_ms' }, 'avg', signal).then((raw) => parseLatencyQuery(raw)),
    optional(queryMetrics(uuid, hours, { metric_key: 'ping.latency_ms' }, 'stddev', signal).then((raw) => parseLatencyQuery(raw))),
    optional(queryMetrics(uuid, hours, { metric_key: 'ping.loss' }, 'avg', signal).then((raw) => parseLatencyQuery(raw))),
  ]);
  return mergeLatencyQuality(average, deviation, loss);
}

export type LiveSocketScope = 'all' | 'node';

export type LiveSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

export type LiveSocketOptions = {
  scope: LiveSocketScope;
  uuid?: string;
  nodeUuid?: () => string | undefined;
  onSnapshot: (snapshot: LiveSnapshot, uuid: string | undefined) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: LiveSocketStatus) => void;
};

export type LiveSocketHandle = {
  request: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

export function createLiveSocket(options: LiveSocketOptions): LiveSocketHandle {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let paused = false;
  let pendingUuid: string | undefined | null = null;
  let responseTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  const setStatus = (status: LiveSocketStatus): void => options.onStatusChange?.(status);

  const clearResponseTimer = (): void => {
    if (responseTimer !== null) {
      clearTimeout(responseTimer);
      responseTimer = null;
    }
  };

  const endpoint = (): string => {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const url = new URL('/api/clients', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  };

  const desiredUuid = (): string | undefined => options.nodeUuid
    ? options.nodeUuid()
    : options.scope === 'node' ? options.uuid : undefined;

  const request = (timeoutMs = 9000): void => {
    const current = socket;
    if (paused || current?.readyState !== WebSocket.OPEN || responseTimer !== null) {
      return;
    }
    try {
      pendingUuid = desiredUuid();
      current.send(pendingUuid ? `get ${pendingUuid}` : 'get');
      responseTimer = setTimeout(() => fail(current, new Error('/api/clients: snapshot timed out')), timeoutMs);
    } catch (error) {
      fail(current, error);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || paused || timer !== null) {
      return;
    }
    const delay = delays[Math.min(retryIndex, delays.length - 1)] ?? 30000;
    retryIndex += 1;
    setStatus('reconnecting');
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  };

  const fail = (current: WebSocket, error: unknown): void => {
    if (socket !== current) {
      return;
    }
    socket = null;
    pendingUuid = null;
    clearResponseTimer();
    current.close();
    if (paused) return;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
    setStatus('error');
    scheduleReconnect();
  };

  const connect = (): void => {
    if (stopped || paused) {
      return;
    }
    setStatus(retryIndex === 0 ? 'connecting' : 'reconnecting');
    try {
      const current = new WebSocket(endpoint());
      socket = current;
      responseTimer = setTimeout(() => fail(current, new Error('/api/clients: connection timed out')), 9000);
      current.addEventListener('open', () => {
        if (socket !== current) {
          return;
        }
        clearResponseTimer();
        request();
      });
      current.addEventListener('message', (event) => {
        if (socket !== current || pendingUuid === null || typeof event.data !== 'string') {
          return;
        }
        try {
          const requestedUuid = pendingUuid;
          pendingUuid = null;
          clearResponseTimer();
          if (paused) return;
          retryIndex = 0;
          if (requestedUuid !== desiredUuid()) {
            request();
            return;
          }
          const snapshot = parseLiveSnapshot(JSON.parse(event.data) as unknown);
          options.onSnapshot(snapshot, requestedUuid);
          setStatus('connected');
        } catch (error) {
          fail(current, error);
        }
      });
      current.addEventListener('error', () => fail(current, new Error('/api/clients: websocket error')));
      current.addEventListener('close', () => {
        if (socket === current) {
          socket = null;
          pendingUuid = null;
          clearResponseTimer();
          scheduleReconnect();
        }
      });
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      setStatus('error');
      scheduleReconnect();
    }
  };

  const cancelReconnect = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const closeConnection = (): void => {
    clearResponseTimer();
    const current = socket;
    socket = null;
    pendingUuid = null;
    current?.close();
  };

  connect();
  return {
    request,
    pause: () => {
      paused = true;
      cancelReconnect();
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      // An untagged reply from before the pause cannot serve as the fresh snapshot.
      if (socket?.readyState !== WebSocket.OPEN || pendingUuid !== null) {
        closeConnection();
        connect();
      } else {
        // Safari can report OPEN after the connection stopped responding in the background.
        request(2000);
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelReconnect();
      closeConnection();
      setStatus('stopped');
    },
  };
}
