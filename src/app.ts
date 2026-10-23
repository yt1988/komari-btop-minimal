import {
  createLiveSocket,
  fetchLatency,
  fetchLoadRecordTimes,
  fetchNodeMetadata,
  fetchPingTasks,
  fetchPublicSettings,
} from './api/komari';
import type { LatencyQuery, LiveReport, LiveSnapshot, NodeMetadata, NodeState, PingTask } from './domain';
import { reconcileLiveSnapshot } from './live';
import { formatTimestamp } from './format';
import { parseLatencyRange, resolveLatencyTargets, toggleVisibleTasks } from './latency';
import {
  parseLatencyColorRegistry,
  reconcileLatencyColors,
  serializeLatencyColorRegistry,
  type NodeLatencyColorRegistry,
} from './latencyColors';
import { legacyRoutePath, parseRoute as parseBrowserRoute, routePath, type Route } from './router';
import { createLatencyCache } from './latencyCache';
import { STATUS_FINE_HOURS, STATUS_HISTORY_HOURS, buildOutages } from './statusHistory';
import { setChartOffline } from './views/chart';
import { renderDetailView, updateDetailCore } from './views/detail';
import { renderNodeList, updateNodeRows } from './views/nodes';
import { renderNodeSwitcher } from './views/switcher';
import type { StatusView } from './views/status';

const DEFAULT_LATENCY_HOURS = 24;
const LATENCY_REFRESH_MS = 60_000;

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
  statusFine: number[] | null;
  statusCoarse: number[] | null;
};

let nodeMetadataCache: NodeMetadata[] | null = null;

const LATENCY_RANGE_KEY = 'komari-btop-minimal:latency-range:v1';

/** The latency range last picked on any detail page; it applies to every node. */
function storedLatencyRange(): number {
  try {
    return parseLatencyRange(window.localStorage.getItem(LATENCY_RANGE_KEY)) ?? DEFAULT_LATENCY_HOURS;
  } catch {
    return DEFAULT_LATENCY_HOURS;
  }
}

function storeLatencyRange(hours: number): void {
  try {
    window.localStorage.setItem(LATENCY_RANGE_KEY, String(hours));
  } catch {
  }
}

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
    && typeof node.trafficLimitType === 'string'
    && (node.createdAt === null || typeof node.createdAt === 'number');
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
    latencyRange: storedLatencyRange(),
    latency: null,
    latencyStatus: 'loading',
    visibleTaskIds: null,
    statusFine: null,
    statusCoarse: null,
  };
  let statusController: AbortController | null = null;
  let statusRequestId = 0;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let statusCoarseAt = 0;
  const latencyCache = createLatencyCache((uuid, hours) => fetchLatency(uuid, hours));
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

  // Before the first snapshot nothing is known about liveness. Treating nodes as
  // online then renders neutral "--" placeholders instead of a red offline flash
  // over the cached node list; the status dot itself shows the pending state.
  const getNodeStates = (): NodeState[] => state.nodes.map((metadata) => ({
    metadata,
    live: state.lastUpdate !== null,
    online: state.lastUpdate === null || state.online.has(metadata.uuid),
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

  const getStatusView = (node: NodeState | null): StatusView => {
    const now = Date.now();
    const input = {
      fineTimes: state.statusFine,
      coarseTimes: state.statusCoarse,
      now,
      online: node?.online ?? false,
      lastReportAt: node?.lastReportAt ?? null,
      createdAt: node?.metadata.createdAt ?? null,
    };
    const outages = node && state.statusCoarse !== null ? buildOutages(input) : null;
    return {
      outages,
      now,
    };
  };

  const updateCore = (): void => {
    const core = page.querySelector<HTMLElement>('.detail-core');
    if (core && state.route.type === 'detail') {
      const node = getCurrentNode();
      updateDetailCore(core, node, getStatusView(node));
    }
  };

  // Records arrive after the chart, so only the status and the charts' offline
  // bands change; redrawing the charts would drop an in-progress hover readout.
  const applyOutages = (): void => {
    updateCore();
    const outages = getStatusView(getCurrentNode()).outages ?? [];
    page.querySelectorAll<HTMLElement>('.chart-container').forEach((chart) => setChartOffline(chart, outages));
  };

  const clearStatusRefresh = (): void => {
    if (statusRefreshTimer !== null) {
      clearTimeout(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  /**
   * Loads the record times behind the outage list and chart offline bands:
   * per-minute data for the last 6h every call, five-minute data for 24h at
   * most every 10 minutes.
   */
  const loadStatusRecords = (uuid: string): void => {
    clearStatusRefresh();
    statusController?.abort();
    const requestId = ++statusRequestId;
    const controller = new AbortController();
    statusController = controller;
    const refreshCoarse = state.statusCoarse === null || Date.now() - statusCoarseAt > 600_000;
    void Promise.all([
      fetchLoadRecordTimes(uuid, STATUS_FINE_HOURS, controller.signal),
      refreshCoarse ? fetchLoadRecordTimes(uuid, STATUS_HISTORY_HOURS, controller.signal) : Promise.resolve(state.statusCoarse ?? []),
    ]).then(([fine, coarse]) => {
      if (stopped || requestId !== statusRequestId || state.route.type !== 'detail' || state.route.uuid !== uuid) {
        return;
      }
      if (refreshCoarse) {
        statusCoarseAt = Date.now();
      }
      state.statusFine = fine;
      state.statusCoarse = coarse;
      applyOutages();
      statusRefreshTimer = setTimeout(() => loadStatusRecords(uuid), 120_000);
    }).catch((error: unknown) => {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (stopped || requestId !== statusRequestId || aborted) {
        return;
      }
      statusRefreshTimer = setTimeout(() => loadStatusRecords(uuid), 60_000);
    }).finally(() => {
      if (statusController === controller) {
        statusController = null;
      }
    });
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
    // Hovering a node name warms what its detail page needs first.
    onNodeIntent: (uuid: string) => {
      latencyCache.prefetch(uuid, state.latencyRange, LATENCY_REFRESH_MS);
      void ensurePingTasks();
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
    const node = getCurrentNode();
    renderDetailView(page, {
      node,
      status: getStatusView(node),
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
          storeLatencyRange(hours);
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

  /**
   * Shows cached data for the node and range at once when there is any, then
   * refreshes it; `refresh` skips the cache for the periodic update.
   */
  const loadLatency = (uuid: string, hours: number, refresh = false): void => {
    clearLatencyRefresh();
    const requestId = ++latencyRequestId;
    const current = (): boolean => !stopped && requestId === latencyRequestId
      && state.route.type === 'detail' && state.route.uuid === uuid && state.latencyRange === hours;
    const cached = refresh ? null : latencyCache.peek(uuid, hours);
    if (cached) {
      state.latency = cached.query;
      state.latencyStatus = 'ready';
      render();
      if (cached.ageMs < LATENCY_REFRESH_MS) {
        latencyRefreshTimer = setTimeout(() => loadLatency(uuid, hours, true), LATENCY_REFRESH_MS - cached.ageMs);
        return;
      }
    } else if (state.latency === null) {
      state.latencyStatus = 'loading';
      render();
    }
    void latencyCache.fetch(uuid, hours).then((query) => {
      if (!current()) {
        return;
      }
      state.latency = query;
      state.latencyStatus = 'ready';
      render();
      latencyRefreshTimer = setTimeout(() => loadLatency(uuid, hours, true), LATENCY_REFRESH_MS);
    }).catch(() => {
      if (!current()) {
        return;
      }
      // Keep showing data that is already on screen; only an empty chart turns into an error.
      if (state.latency === null) {
        state.latencyStatus = 'error';
        render();
      }
      latencyRefreshTimer = setTimeout(() => loadLatency(uuid, hours, true), 15_000);
    });
  };

  /** Starts everything a detail page needs; nothing waits on the node list, the uuid comes from the URL. */
  const startDetailLoads = (uuid: string): void => {
    loadStatusRecords(uuid);
    void ensurePingTasks();
    loadLatency(uuid, state.latencyRange);
  };

  // Node switcher on detail pages: the node name toggles it under the name, and a
  // double click anywhere outside controls and charts opens it at the pointer.
  let switcher: HTMLElement | null = null;

  const closeSwitcher = (refocus = false): void => {
    if (!switcher) {
      return;
    }
    switcher.remove();
    switcher = null;
    const trigger = page.querySelector<HTMLButtonElement>('[data-role="node-switch"]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (refocus) {
      trigger?.focus();
    }
  };

  /** Opens the list with its top-left at a viewport point, flipping above it near the bottom edge. */
  const openSwitcher = (clientX: number, clientY: number): HTMLElement | null => {
    if (state.route.type !== 'detail') {
      return null;
    }
    closeSwitcher();
    const currentUuid = state.route.uuid;
    const list = renderNodeSwitcher(getNodeStates(), currentUuid, {
      onSelect: (uuid) => {
        closeSwitcher();
        if (uuid !== currentUuid) {
          navigate({ type: 'detail', uuid });
        }
      },
      onIntent: nodeHandlers.onNodeIntent,
    });
    page.append(list);
    switcher = list;
    const bounds = page.getBoundingClientRect();
    const top = clientY + list.offsetHeight <= window.innerHeight - 8 ? clientY : clientY - list.offsetHeight;
    list.style.left = `${Math.max(0, Math.min(clientX - bounds.left, page.clientWidth - list.offsetWidth))}px`;
    list.style.top = `${Math.max(0, top - bounds.top)}px`;
    page.querySelector('[data-role="node-switch"]')?.setAttribute('aria-expanded', 'true');
    return list;
  };

  const handlePageClick = (event: MouseEvent): void => {
    const trigger = event.target instanceof Element ? event.target.closest('[data-role="node-switch"]') : null;
    if (!trigger) {
      return;
    }
    if (switcher) {
      closeSwitcher();
      return;
    }
    const anchor = trigger.getBoundingClientRect();
    const list = openSwitcher(anchor.left, anchor.bottom + 6);
    // Opened from the keyboard: move focus into the list.
    if (event.detail === 0) {
      list?.querySelector<HTMLElement>('.is-current')?.focus();
    }
  };

  const isBlankDetailSpot = (target: EventTarget | null): boolean => state.route.type === 'detail'
    && target instanceof Element
    && !target.closest('button, a, input, .chart-container, .node-switcher');

  const handlePageMouseDown = (event: MouseEvent): void => {
    // Keep the double click from selecting a word.
    if (event.detail > 1 && isBlankDetailSpot(event.target)) {
      event.preventDefault();
    }
  };

  const handlePageDoubleClick = (event: MouseEvent): void => {
    if (isBlankDetailSpot(event.target)) {
      window.getSelection()?.removeAllRanges();
      openSwitcher(event.clientX, event.clientY);
    }
  };

  const handleDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (switcher && !switcher.contains(target) && !target?.closest('[data-role="node-switch"]')) {
      closeSwitcher();
    }
  };

  const handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && switcher) {
      closeSwitcher(true);
    }
  };

  const syncRoute = (): void => {
    const route = currentRoute();
    const key = routeKey(route);
    if (key === state.routeKey) {
      return;
    }
    closeSwitcher();
    state.route = route;
    state.routeKey = key;
    clearLatencyRefresh();
    latencyRequestId += 1;
    state.latency = null;
    state.latencyStatus = 'loading';
    state.visibleTaskIds = null;
    clearStatusRefresh();
    statusController?.abort();
    statusController = null;
    state.statusFine = null;
    state.statusCoarse = null;
    if (route.type === 'detail') {
      startDetailLoads(route.uuid);
      return;
    }
    render();
  };

  const refreshMetadata = async (): Promise<void> => {
    if (nodeMetadataCache === null) {
      try {
        const cached = window.localStorage.getItem('komari-btop-minimal:nodes:v1');
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
        window.localStorage.setItem('komari-btop-minimal:nodes:v1', JSON.stringify(nodes));
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

    if (!hadSnapshot) {
      // Every node leaves the pending state at once, including ones with no report.
      render();
      return;
    }
    if (reconciled.changedUuids.size === 0) {
      return;
    }
    if (state.route.type === 'detail') {
      if (!reconciled.changedUuids.has(state.route.uuid)) {
        return;
      }
      if (hadSnapshot && reconciled.onlineChangedUuids.has(state.route.uuid)) {
        // Redraw the chart's offline bands now; records catch up a minute later.
        render();
        const uuid = state.route.uuid;
        clearStatusRefresh();
        statusRefreshTimer = setTimeout(() => loadStatusRecords(uuid), 75_000);
        return;
      }
      updateCore();
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
  page.addEventListener('click', handlePageClick);
  document.addEventListener('mousedown', handlePageMouseDown);
  document.addEventListener('dblclick', handlePageDoubleClick);
  document.addEventListener('mousedown', handleDocumentMouseDown);
  document.addEventListener('keydown', handleDocumentKeyDown);
  void loadSiteName();
  void refreshMetadata();
  liveSocket = createLiveSocket({
    scope: 'all',
    onSnapshot: applySnapshot,
    onStatusChange: updateLiveConnection,
  });
  refreshTimer = setInterval(() => {
    liveSocket?.request();
    // An offline node sends no reports, so keep its outage duration ticking.
    if (state.route.type === 'detail' && !state.online.has(state.route.uuid)) {
      updateCore();
    }
  }, 3000);
  metadataTimer = setInterval(() => void refreshMetadata(), 60_000);
  if (state.route.type === 'detail') {
    state.routeKey = routeKey(state.route);
    startDetailLoads(state.route.uuid);
  } else {
    state.routeKey = 'nodes';
    render();
  }

  return () => {
    stopped = true;
    clearLatencyRefresh();
    clearStatusRefresh();
    statusController?.abort();
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
    page.removeEventListener('click', handlePageClick);
    document.removeEventListener('mousedown', handlePageMouseDown);
    document.removeEventListener('dblclick', handlePageDoubleClick);
    document.removeEventListener('mousedown', handleDocumentMouseDown);
    document.removeEventListener('keydown', handleDocumentKeyDown);
  };
}

