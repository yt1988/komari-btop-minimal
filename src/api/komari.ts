import type {
  LatencyQuery,
  LiveReport,
  LiveSnapshot,
  NodeMetadata,
  PingTask,
} from '../domain';

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

export function parseLatencyQuery(raw: unknown): LatencyQuery {
  const data = asObject(unwrapRpcResponse(raw, '/api/rpc2'), '/api/rpc2');
  const rawSeries = asArray(data.series, '/api/rpc2');
  let intervalSeconds = asFiniteNumber(data.interval_seconds);
  const series = rawSeries.map((item, index) => {
    const source = asObject(item, '/api/rpc2');
    if (intervalSeconds <= 0) {
      intervalSeconds = asFiniteNumber(source.interval_seconds);
    }
    const tags = recordValue(source, 'tags');
    const taskId = asStringId(tags.task_id) || asStringId(source.task_id) || `series-${index + 1}`;
    const points = asArray(source.points, '/api/rpc2').map((point) => {
      const value = asObject(point, '/api/rpc2');
      const timestamp = parseTimestamp(value.time ?? value.timestamp);
      if (timestamp === null) {
        throw new Error('/api/rpc2: latency point is missing time');
      }
      return { timestamp, value: asNullableNumber(value.value) };
    });
    return {
      taskId,
      label: asString(tags.task_name, asString(source.name, taskId)),
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

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function fetchNodeMetadata(signal?: AbortSignal): Promise<NodeMetadata[]> {
  return parseNodeMetadata(await fetchJson('/api/nodes', { signal }));
}

export async function fetchPublicSettings(signal?: AbortSignal): Promise<PublicSettings> {
  return parsePublicSettings(await fetchJson('/api/public', { signal }));
}

export async function fetchPingTasks(signal?: AbortSignal): Promise<PingTask[]> {
  return parsePingTasks(await fetchJson('/api/task/ping', { signal }));
}

export async function fetchLatency(uuid: string, hours: number, signal?: AbortSignal): Promise<LatencyQuery> {
  const raw = await fetchJson('/api/rpc2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `latency-${uuid}-${hours}`,
      method: 'public:queryMetrics',
      params: {
        metric_key: 'ping.latency_ms',
        entity_id: uuid,
        hours,
        max_points: 480,
        aggregation: 'avg',
        fill_empty: false,
      },
    }),
  });
  return parseLatencyQuery(raw);
}

export type LiveSocketScope = 'all' | 'node';

export type LiveSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

export type LiveSocketOptions = {
  scope: LiveSocketScope;
  uuid?: string;
  onSnapshot: (snapshot: LiveSnapshot) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: LiveSocketStatus) => void;
};

export type LiveSocketHandle = {
  request: () => void;
  stop: () => void;
};

export function createLiveSocket(options: LiveSocketOptions): LiveSocketHandle {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let requestPending = false;
  let retryIndex = 0;
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  const setStatus = (status: LiveSocketStatus): void => options.onStatusChange?.(status);

  const endpoint = (): string => {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    const url = new URL('/api/clients', base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  };

  const requestMessage = (): string => options.scope === 'node' && options.uuid ? `get ${options.uuid}` : 'get';

  const request = (): void => {
    if (socket?.readyState !== WebSocket.OPEN || requestPending) {
      return;
    }
    requestPending = true;
    socket.send(requestMessage());
  };

  const scheduleReconnect = (): void => {
    if (stopped || timer !== null) {
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

  const connect = (): void => {
    if (stopped) {
      return;
    }
    requestPending = false;
    setStatus(retryIndex === 0 ? 'connecting' : 'reconnecting');
    try {
      socket = new WebSocket(endpoint());
      socket.addEventListener('open', () => {
        if (stopped) {
          return;
        }
        setStatus('connected');
        request();
      });
      socket.addEventListener('message', (event) => {
        requestPending = false;
        if (typeof event.data !== 'string') {
          return;
        }
        try {
          options.onSnapshot(parseLiveSnapshot(JSON.parse(event.data) as unknown));
          retryIndex = 0;
          setStatus('connected');
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          setStatus('error');
        }
      });
      socket.addEventListener('error', () => {
        options.onError?.(new Error('/api/clients: websocket error'));
        setStatus('error');
      });
      socket.addEventListener('close', () => {
        socket = null;
        requestPending = false;
        if (!stopped) {
          scheduleReconnect();
        }
      });
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      setStatus('error');
      scheduleReconnect();
    }
  };

  connect();
  return {
    request,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      requestPending = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket?.close();
      socket = null;
      setStatus('stopped');
    },
  };
}

