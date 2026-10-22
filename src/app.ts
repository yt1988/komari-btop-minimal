import {
  createLiveSocket,
  fetchLatency,
  fetchNodeMetadata,
  fetchPingTasks,
  fetchPublicSettings,
} from './api/komari';
import type { LatencyQuery, LiveReport, LiveSnapshot, NodeMetadata, NodeState, PingTask } from './domain';
import { reconcileLiveSnapshot } from './live';
import { formatTimestamp } from './format';
import { resolveLatencyTargets, toggleVisibleTasks } from './latency';
import {
  parseLatencyColorRegistry,
  reconcileLatencyColors,
  serializeLatencyColorRegistry,
  type NodeLatencyColorRegistry,
} from './latencyColors';
import { legacyRoutePath, parseRoute as parseBrowserRoute, routePath, type Route } from './router';
import { renderDetailView, updateDetailCore } from './views/detail';
import { renderNodeList, updateNodeRows } from './views/nodes';

type LatencyStatus = 'loading' | 'ready' | 'error';
type LiveConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

type ApplicationState = {
  nodes: NodeMetadata[];
  reports: Map<string, LiveReport>;
  online: Set<string>;
  tasks: PingTask[];
  tasksReady: boolean;
  metadataReady: boolean;
  metadataFailed: boolean;
  selectedGroup: string;
  lastUpdate: number | null;
  lastSnapshotTimestamp: number | null;
  liveConnection: LiveConnectionStatus;
  route: Route;
  routeKey: string;
  latencyRange: number;
  latency: LatencyQuery | null;
  latencyStatus: LatencyStatus;
  visibleTaskIds: string[] | null;
};

let nodeMetadataCache: NodeMetadata[] | null = null;

function isNodeMetadata(value: unknown): value is NodeMetadata {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const node = value as Partial<NodeMetadata>;
  return typeof node.uuid === 'string'
    && typeof node.name === 'string'
    && typeof node.group === 'string'
    && typeof node.region === 'string'
    && typeof node.weight === 'number'
    && typeof node.memTotal === 'number'
    && typeof node.diskTotal === 'number'
    && typeof node.trafficLimit === 'number'
    && typeof node.trafficLimitType === 'string';
}

function currentRoute(): Route {
  return parseBrowserRoute(window.location.pathname, window.location.hash);
}

function navigate(route: Route): void {
  window.history.pushState(null, '', routePath(route));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function routeKey(route: Route): string {
  return route.type === 'nodes' ? 'nodes' : `detail:${route.uuid}`;
}

function formatRefreshTime(timestamp: number | null): string {
  if (timestamp === null) {
    return 'last update: --';
  }
  const date = new Date(timestamp);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  return `last update: ${parts.join('/')} ${formatTimestamp(timestamp)}`;
}

function latencyTargets(state: ApplicationState, uuid: string): Map<string, string> {
  return resolveLatencyTargets(state.tasks, state.tasksReady, uuid, state.latency?.series ?? []);
}

function allTaskIds(state: ApplicationState, uuid: string): string[] {
  return [...latencyTargets(state, uuid).keys()];
}

export function startApp(root: HTMLElement): () => void {
  const migratedPath = legacyRoutePath(window.location.hash);
  if (migratedPath !== null) {
    window.history.replaceState(null, '', migratedPath);
  }
  root.innerHTML = '<div class="terminal"><header class="header"><div><span class="prompt" data-role="site-name">Komari</span>:~$ nodes</div><div class="header-right" data-role="last-update">last update: --</div><div class="header-live" data-role="live-status" aria-live="polite" aria-atomic="true"></div></header><main data-role="page"></main></div>';
  const page = root.querySelector<HTMLElement>('[data-role="page"]');
  const timestamp = root.querySelector<HTMLElement>('[data-role="last-update"]');
  const siteName = root.querySelector<HTMLElement>('[data-role="site-name"]');
  const liveStatus = root.querySelector<HTMLElement>('[data-role="live-status"]');
  if (!page || !timestamp || !siteName || !liveStatus) {
    throw new Error('Missing application shell elements');
  }

  const state: ApplicationState = {
    nodes: [],
    reports: new Map(),
    online: new Set(),
    tasks: [],
    tasksReady: false,
    metadataReady: false,
    metadataFailed: false,
    selectedGroup: 'all',
    lastUpdate: null,
    lastSnapshotTimestamp: null,
    liveConnection: 'connecting',
    route: currentRoute(),
    routeKey: '',
    latencyRange: 24,
    latency: null,
    latencyStatus: 'loading',
    visibleTaskIds: null,
  };
  let latencyController: AbortController | null = null;
  let latencyRequestId = 0;
  let latencyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let metadataController: AbortController | null = null;
  let metadataRequestId = 0;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let metadataTimer: ReturnType<typeof setInterval> | null = null;
  let liveSocket: ReturnType<typeof createLiveSocket> | null = null;
  let pingTasksRequest: Promise<PingTask[]> | null = null;
  const latencyColorRegistry: NodeLatencyColorRegistry = (() => {
    try {
      return parseLatencyColorRegistry(JSON.parse(window.sessionStorage.getItem('komari-btop-minimal:latency-colors:v1') ?? '[]'));
    } catch {
      return new Map();
    }
  })();

  const persistLatencyColors = (): void => {
    try {
      window.sessionStorage.setItem('komari-btop-minimal:latency-colors:v1', JSON.stringify(serializeLatencyColorRegistry(latencyColorRegistry)));
    } catch {
    }
  };

  const getNodeStates = (): NodeState[] => state.nodes.map((metadata) => ({
    metadata,
    online: state.online.has(metadata.uuid),
    report: state.reports.get(metadata.uuid) ?? null,
    lastReportAt: state.reports.get(metadata.uuid)?.updatedAt ?? null,
  }));

  const getCurrentNode = (): NodeState | null => {
    const route = state.route;
    if (route.type !== 'detail') {
      return null;
    }
    return getNodeStates().find((node) => node.metadata.uuid === route.uuid) ?? null;
  };

  const updateTimestamp = (): void => {
    timestamp.textContent = formatRefreshTime(state.lastUpdate);
  };

  const announce = (message: string): void => {
    liveStatus.textContent = message;
  };

  const updateLiveConnection = (status: LiveConnectionStatus): void => {
    const previous = state.liveConnection;
    state.liveConnection = status;
    if (status === 'error') {
      announce('live telemetry unavailable; reconnecting');
    } else if (status === 'reconnecting' && previous !== 'reconnecting') {
      announce('reconnecting live telemetry');
    } else if (status === 'connected' && previous === 'error') {
      announce('live telemetry connected; waiting for data');
    }
  };

  const loadSiteName = async (): Promise<void> => {
    try {
      const settings = await fetchPublicSettings();
      if (!stopped) {
        siteName.textContent = settings.siteName;
      }
    } catch {
    }
  };

  const nodeHandlers = {
    onGroupSelect: (group: string) => {
      state.selectedGroup = group;
      render();
    },
    onNodeSelect: (uuid: string) => {
      navigate({ type: 'detail', uuid });
    },
  };

  const ensurePingTasks = (): Promise<PingTask[]> => {
    if (state.tasksReady) {
      return Promise.resolve(state.tasks);
    }
    if (pingTasksRequest !== null) {
      return pingTasksRequest;
    }
    pingTasksRequest = fetchPingTasks().then((tasks) => {
      if (!stopped) {
        state.tasks = tasks;
        state.tasksReady = true;
        if (state.route.type === 'detail') {
          render();
        }
      }
      return tasks;
    }).catch(() => {
      if (!stopped && state.route.type === 'detail') {
        announce('latency targets unavailable; retrying when needed');
      }
      return [];
    }).finally(() => {
      pingTasksRequest = null;
    });
    return pingTasksRequest;
  };

  const render = (): void => {
    state.route = currentRoute();
    updateTimestamp();
    if (!state.metadataReady && state.nodes.length === 0) {
      const loading = document.createElement('div');
      loading.className = 'empty-state muted';
      loading.textContent = 'loading nodes';
      page.replaceChildren(loading);
      return;
    }
    if (state.route.type === 'nodes') {
      renderNodeList(page, getNodeStates(), state.selectedGroup, nodeHandlers, state.metadataFailed ? 'unable to load nodes' : 'no nodes');
      return;
    }

    const ids = allTaskIds(state, state.route.uuid);
    let visible = state.visibleTaskIds === null
      ? ids
      : state.visibleTaskIds.filter((id) => ids.includes(id));
    if (state.visibleTaskIds !== null && visible.length === 0) {
      state.visibleTaskIds = null;
      visible = ids;
    }
    const detailRoute = state.route;
    const colorPlan = reconcileLatencyColors(latencyColorRegistry, detailRoute.uuid, ids);
    persistLatencyColors();
    renderDetailView(page, {
      node: getCurrentNode(),
      targets: latencyTargets(state, detailRoute.uuid),
      latency: state.latency,
      latencyState: state.latencyStatus,
      latencyRange: state.latencyRange,
      visibleTaskIds: visible,
      colorAssignments: colorPlan.assignments,
      overflowTaskIds: colorPlan.overflowTaskIds,
      handlers: {
        onBack: () => {
          navigate({ type: 'nodes' });
        },
        onRangeChange: (hours) => {
          if (state.latencyRange === hours) {
            return;
          }
          state.latencyRange = hours;
          loadLatency(detailRoute.uuid, hours);
        },
        onLatencyRetry: () => {
          loadLatency(detailRoute.uuid, state.latencyRange);
        },
        onTaskToggle: (taskId) => {
          const currentIds = allTaskIds(state, detailRoute.uuid);
          const currentVisible = state.visibleTaskIds === null ? currentIds : state.visibleTaskIds;
          state.visibleTaskIds = toggleVisibleTasks(currentIds, currentVisible, taskId);
          render();
        },
      },
    });
  };

  const clearLatencyRefresh = (): void => {
    if (latencyRefreshTimer !== null) {
      clearTimeout(latencyRefreshTimer);
      latencyRefreshTimer = null;
    }
  };

  const loadLatency = (uuid: string, hours: number): void => {
    clearLatencyRefresh();
    latencyController?.abort();
    const requestId = ++latencyRequestId;
    const controller = new AbortController();
    latencyController = controller;
    state.latencyStatus = state.latency === null ? 'loading' : 'ready';
    if (state.latency === null) {
      render();
    }
    void fetchLatency(uuid, hours, controller.signal).then((query) => {
      if (stopped || requestId !== latencyRequestId || state.route.type !== 'detail' || state.route.uuid !== uuid || state.latencyRange !== hours) {
        return;
      }
      state.latency = query;
      state.latencyStatus = 'ready';
      render();
      latencyRefreshTimer = setTimeout(() => loadLatency(uuid, hours), 60_000);
    }).catch((error: unknown) => {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (stopped || requestId !== latencyRequestId || aborted) {
        return;
      }
      state.latencyStatus = 'error';
      render();
      latencyRefreshTimer = setTimeout(() => loadLatency(uuid, hours), 15_000);
    }).finally(() => {
      if (latencyController === controller) {
        latencyController = null;
      }
    });
  };

  const syncRoute = (): void => {
    const route = currentRoute();
    const key = routeKey(route);
    if (key === state.routeKey) {
      return;
    }
    state.route = route;
    state.routeKey = key;
    clearLatencyRefresh();
    latencyController?.abort();
    latencyController = null;
    state.latency = null;
    state.latencyRange = 24;
    state.latencyStatus = 'loading';
    state.visibleTaskIds = null;
    if (route.type === 'detail' && state.metadataReady && state.nodes.some((node) => node.uuid === route.uuid)) {
      void ensurePingTasks();
      loadLatency(route.uuid, state.latencyRange);
      return;
    }
    render();
  };

  const refreshMetadata = async (): Promise<void> => {
    if (nodeMetadataCache === null) {
      try {
        const cached = window.sessionStorage.getItem('komari-btop-minimal:nodes:v1');
        const parsed: unknown = cached ? JSON.parse(cached) : null;
        if (Array.isArray(parsed) && parsed.every(isNodeMetadata)) {
          nodeMetadataCache = parsed;
        }
      } catch {
        nodeMetadataCache = null;
      }
    }
    if (nodeMetadataCache !== null && state.nodes.length === 0) {
      state.nodes = nodeMetadataCache;
      state.metadataReady = true;
      render();
      const cachedRoute = state.route;
      if (cachedRoute.type === 'detail' && state.nodes.some((node) => node.uuid === cachedRoute.uuid)) {
        void ensurePingTasks();
        loadLatency(cachedRoute.uuid, state.latencyRange);
      }
    }

    metadataController?.abort();
    const controller = new AbortController();
    metadataController = controller;
    const requestId = ++metadataRequestId;
    try {
      const nodes = await fetchNodeMetadata(controller.signal);
      if (stopped || requestId !== metadataRequestId) {
        return;
      }
      state.nodes = nodes;
      nodeMetadataCache = nodes;
      try {
        window.sessionStorage.setItem('komari-btop-minimal:nodes:v1', JSON.stringify(nodes));
      } catch {
      }
      state.metadataFailed = false;
    } catch (error: unknown) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (stopped || requestId !== metadataRequestId || aborted) {
        return;
      }
      state.metadataFailed = state.nodes.length === 0;
    } finally {
      if (metadataController === controller) {
        metadataController = null;
      }
    }
    if (stopped || requestId !== metadataRequestId) {
      return;
    }
    state.metadataReady = true;
    if (state.selectedGroup !== 'all' && !state.nodes.some((node) => node.group.trim() === state.selectedGroup)) {
      state.selectedGroup = 'all';
    }
    const route = state.route;
    if (route.type === 'detail' && state.nodes.some((node) => node.uuid === route.uuid) && latencyController === null && state.latency === null) {
      void ensurePingTasks();
      loadLatency(route.uuid, state.latencyRange);
      return;
    }
    render();
  };

  const applySnapshot = (snapshot: LiveSnapshot): void => {
    const reconciled = reconcileLiveSnapshot(
      state.online,
      state.reports,
      snapshot,
      state.lastSnapshotTimestamp,
    );
    if (reconciled === null) {
      return;
    }
    const hadSnapshot = state.lastUpdate !== null;
    state.online = reconciled.online;
    state.reports = reconciled.reports;
    state.lastSnapshotTimestamp = reconciled.latestTimestamp ?? state.lastSnapshotTimestamp;
    state.lastUpdate = Date.now();
    updateTimestamp();

    if (hadSnapshot && reconciled.onlineChangedUuids.size > 0) {
      const route = state.route;
      if (route.type === 'detail' && reconciled.onlineChangedUuids.has(route.uuid)) {
        announce(`${getCurrentNode()?.metadata.name ?? 'node'} is ${state.online.has(route.uuid) ? 'online' : 'offline'}`);
      } else if (reconciled.onlineChangedUuids.size === 1) {
        const uuid = [...reconciled.onlineChangedUuids][0] ?? '';
        const name = state.nodes.find((node) => node.uuid === uuid)?.name ?? 'node';
        announce(`${name} is ${state.online.has(uuid) ? 'online' : 'offline'}`);
      } else {
        announce(`${reconciled.onlineChangedUuids.size} node availability changes`);
      }
    }

    if (reconciled.changedUuids.size === 0) {
      return;
    }
    if (state.route.type === 'detail') {
      if (!reconciled.changedUuids.has(state.route.uuid)) {
        return;
      }
      const core = page.querySelector<HTMLElement>('.detail-core');
      if (core) {
        updateDetailCore(core, getCurrentNode());
      }
    } else if (state.metadataReady) {
      updateNodeRows(page, getNodeStates(), nodeHandlers, reconciled.changedUuids);
    }
  };

  const handleRouteChange = (): void => {
    const migratedPath = legacyRoutePath(window.location.hash);
    if (migratedPath !== null) {
      window.history.replaceState(null, '', migratedPath);
    }
    syncRoute();
  };

  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('hashchange', handleRouteChange);
  void loadSiteName();
  void refreshMetadata();
  liveSocket = createLiveSocket({
    scope: 'all',
    onSnapshot: applySnapshot,
    onStatusChange: updateLiveConnection,
  });
  refreshTimer = setInterval(() => liveSocket?.request(), 3000);
  metadataTimer = setInterval(() => void refreshMetadata(), 60_000);
  if (state.route.type === 'detail') {
    state.routeKey = routeKey(state.route);
  } else {
    state.routeKey = 'nodes';
    render();
  }

  return () => {
    stopped = true;
    clearLatencyRefresh();
    latencyController?.abort();
    metadataController?.abort();
    liveSocket?.stop();
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
    }
    if (metadataTimer !== null) {
      clearInterval(metadataTimer);
    }
    window.removeEventListener('popstate', handleRouteChange);
    window.removeEventListener('hashchange', handleRouteChange);
  };
}

