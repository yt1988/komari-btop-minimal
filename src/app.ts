import {
  createLiveSocket,
  fetchLatency,
  fetchLoadRecordTimes,
  fetchNodeMetadata,
  fetchPingTasks,
  fetchPublicSettings,
  fetchResourceHistory,
  isAccessDenied,
  type LiveSocketStatus,
} from './api/komari';
import type { HistoryMetric, LatencyQuery, LiveReport, LiveSnapshot, NodeMetadata, NodeState, PingTask } from './domain';
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
const HISTORY_REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 3000;
const LIVE_STALE_MS = 3 * LIVE_REFRESH_MS;

type HistoryStatus = 'loading' | 'ready' | 'error';
type MetadataStatus = 'loading' | 'ready' | 'error' | 'denied';

type ApplicationState = {
  nodes: NodeMetadata[];
  reports: Map<string, LiveReport>;
  online: Set<string>;
  tasks: PingTask[];
  tasksReady: boolean;
  metadataStatus: MetadataStatus;
  selectedGroup: string;
  lastUpdate: number | null;
  lastSnapshotTimestamp: number | null;
  liveConnection: LiveSocketStatus;
  route: Route;
  routeKey: string;
  historyRange: number;
  history: LatencyQuery | null;
  displayedHistoryRange: number | null;
  historyStatus: HistoryStatus;
  visibleTaskIds: string[] | null;
  statusFine: number[] | null;
  statusCoarse: number[] | null;
};

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

function clearLegacyNodeCache(): void {
  // Legacy persistent node lists could have been written by an earlier session.
  try {
    window.localStorage.removeItem('komari-btop-minimal:nodes:v1');
  } catch {
  }
}

function currentRoute(): Route {
  return parseBrowserRoute(window.location.pathname, window.location.hash, window.location.search);
}

function navigate(route: Route): void {
  window.history.pushState(null, '', routePath(route));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function routeKey(route: Route): string {
  return route.type === 'nodes' ? 'nodes' : `detail:${route.uuid}:${route.metric ?? 'latency'}`;
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
  const series = state.route.type === 'detail' && !state.route.metric ? state.history?.series ?? [] : [];
  return resolveLatencyTargets(state.tasks, state.tasksReady, uuid, series);
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

  const chinese = /^zh(?:-|$)/i.test(navigator.language);
  const startedAt = Date.now();
  clearLegacyNodeCache();

  const initialRoute = currentRoute();
  const state: ApplicationState = {
    nodes: [],
    reports: new Map(),
    online: new Set(),
    tasks: [],
    tasksReady: false,
    metadataStatus: 'loading',
    selectedGroup: 'all',
    lastUpdate: null,
    lastSnapshotTimestamp: null,
    liveConnection: 'connecting',
    route: initialRoute,
    routeKey: '',
    historyRange: storedLatencyRange(),
    history: null,
    displayedHistoryRange: null,
    historyStatus: 'loading',
    visibleTaskIds: null,
    statusFine: null,
    statusCoarse: null,
  };
  let statusController: AbortController | null = null;
  let statusRequestId = 0;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let statusCoarseAt = 0;
  const newHistoryCaches = () => ({
    latency: createLatencyCache(fetchLatency),
    cpu: createLatencyCache((uuid, hours) => fetchResourceHistory(uuid, hours, 'cpu')),
    mem: createLatencyCache((uuid, hours) => fetchResourceHistory(uuid, hours, 'mem')),
    network: createLatencyCache((uuid, hours) => fetchResourceHistory(uuid, hours, 'network')),
  });
  let historyCaches = newHistoryCaches();
  let historyRequestId = 0;
  let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
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
  // over the node list; the status dot itself shows the pending state.
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
      recheckAccess(error);
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

  const announce = (message: string): void => {
    liveStatus.textContent = message;
  };

  const updateTimestamp = (): void => {
    const age = Date.now() - (state.lastUpdate ?? startedAt);
    const stale = state.metadataStatus === 'ready' && age >= LIVE_STALE_MS;
    const seconds = Math.floor(age / 1000);
    const staleLabel = state.lastUpdate === null
      ? (chinese ? '等待实时数据' : 'waiting for live data')
      : (chinese ? `数据已过期 · ${seconds} 秒前` : `data stale · ${seconds}s ago`);
    const text = stale ? staleLabel : formatRefreshTime(state.lastUpdate);
    if (timestamp.textContent !== text) {
      timestamp.textContent = text;
    }
    timestamp.classList.toggle('is-stale', stale);
    if (stale && !wasStale) {
      announce(staleLabel);
    } else if (!stale && wasStale && state.lastUpdate !== null) {
      announce(chinese ? '实时数据已恢复' : 'live data restored');
    }
    wasStale = stale;
  };
  let wasStale = false;

  const updateLiveConnection = (status: LiveSocketStatus): void => {
    const previous = state.liveConnection;
    state.liveConnection = status;
    if (status === 'reconnecting' && previous !== 'reconnecting') {
      announce('reconnecting live telemetry');
      if (state.metadataStatus === 'ready' && metadataController === null) {
        void refreshMetadata();
      }
    }
  };

  const recheckAccess = (error: unknown): void => {
    if (!stopped && isAccessDenied(error) && state.metadataStatus === 'ready' && metadataController === null) {
      void refreshMetadata();
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
      if (state.metadataStatus !== 'ready') {
        return;
      }
      const hours = state.route.type === 'detail' ? state.historyRange : storedLatencyRange();
      historyCaches.latency.prefetch(uuid, hours, HISTORY_REFRESH_MS);
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
    const request = fetchPingTasks().then((tasks) => {
      if (!stopped && pingTasksRequest === request) {
        state.tasks = tasks;
        state.tasksReady = true;
        if (state.route.type === 'detail') {
          render();
        }
      }
      return tasks;
    }).catch((error: unknown) => {
      if (pingTasksRequest === request) {
        recheckAccess(error);
        if (!stopped && state.route.type === 'detail') {
          announce('latency targets unavailable; retrying when needed');
        }
      }
      return [];
    }).finally(() => {
      if (pingTasksRequest === request) {
        pingTasksRequest = null;
      }
    });
    pingTasksRequest = request;
    return request;
  };

  const render = (): void => {
    state.route = currentRoute();
    updateTimestamp();
    if (state.metadataStatus !== 'ready') {
      const status = state.metadataStatus;
      const message = document.createElement('div');
      message.className = `empty-state ${status === 'loading' ? 'muted' : 'danger'}`;
      message.setAttribute('role', status === 'loading' ? 'status' : 'alert');
      message.textContent = status === 'denied'
        ? (chinese ? '请登录，或获取新的分享链接。当前分享可能已失效。' : 'Sign in or get a new share link. Your current link may have expired.')
        : status === 'error' ? 'unable to load nodes' : 'loading nodes';
      if (status !== 'loading') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'retry';
        retry.textContent = chinese ? '重试' : 'retry';
        retry.addEventListener('click', () => void refreshMetadata());
        message.append(' ', retry);
      }
      page.replaceChildren(message);
      return;
    }
    if (state.route.type === 'nodes') {
      renderNodeList(page, getNodeStates(), state.selectedGroup, nodeHandlers);
      return;
    }

    const ids = state.route.metric ? [] : allTaskIds(state, state.route.uuid);
    let visible = state.visibleTaskIds === null
      ? ids
      : state.visibleTaskIds.filter((id) => ids.includes(id));
    if (state.visibleTaskIds !== null && visible.length === 0) {
      state.visibleTaskIds = null;
      visible = ids;
    }
    const detailRoute = state.route;
    const colorPlan = detailRoute.metric ? { assignments: new Map<string, string>(), overflowTaskIds: [] }
      : reconcileLatencyColors(latencyColorRegistry, detailRoute.uuid, ids);
    if (!detailRoute.metric) {
      persistLatencyColors();
    }
    const node = getCurrentNode();
    renderDetailView(page, {
      node,
      status: getStatusView(node),
      metric: detailRoute.metric ?? 'latency',
      targets: latencyTargets(state, detailRoute.uuid),
      probeIntervals: new Map(state.tasks.filter((task) => task.interval > 0).map((task) => [task.id, task.interval])),
      history: state.history,
      historyState: state.historyStatus,
      historyRange: state.historyRange,
      displayedHistoryRange: state.displayedHistoryRange,
      chinese,
      visibleTaskIds: visible,
      colorAssignments: colorPlan.assignments,
      overflowTaskIds: colorPlan.overflowTaskIds,
      handlers: {
        onBack: () => {
          navigate({ type: 'nodes' });
        },
        onMetricChange: (metric) => {
          if (state.route.type === 'detail' && metric !== (state.route.metric ?? 'latency')) {
            navigate({ type: 'detail', uuid: state.route.uuid, metric: metric === 'latency' ? undefined : metric });
          }
        },
        onRangeChange: (hours) => {
          if (state.route.type !== 'detail' || state.historyRange === hours) {
            return;
          }
          state.historyRange = hours;
          storeLatencyRange(hours);
          loadHistory(state.route.uuid, state.route.metric ?? 'latency', hours);
        },
        onHistoryRetry: () => {
          loadHistory(detailRoute.uuid, detailRoute.metric ?? 'latency', state.historyRange, true);
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

  const clearHistoryRefresh = (): void => {
    if (historyRefreshTimer !== null) {
      clearTimeout(historyRefreshTimer);
      historyRefreshTimer = null;
    }
  };

  /**
   * Shows cached data for the node and range at once when there is any, then
   * refreshes it; `refresh` skips the cache for the periodic update.
   */
  const loadHistory = (uuid: string, metric: HistoryMetric, hours: number, refresh = false): void => {
    clearHistoryRefresh();
    const requestId = ++historyRequestId;
    const current = (): boolean => !stopped && requestId === historyRequestId
      && state.route.type === 'detail' && state.route.uuid === uuid && (state.route.metric ?? 'latency') === metric && state.historyRange === hours;
    const cache = historyCaches[metric];
    const cached = refresh ? null : cache.peek(uuid, hours);
    if (cached) {
      state.history = cached.query;
      state.displayedHistoryRange = hours;
      state.historyStatus = 'ready';
      render();
      if (cached.ageMs < HISTORY_REFRESH_MS) {
        historyRefreshTimer = setTimeout(() => loadHistory(uuid, metric, hours, true), HISTORY_REFRESH_MS - cached.ageMs);
        return;
      }
    } else if (state.displayedHistoryRange !== hours || state.historyStatus === 'error') {
      state.historyStatus = 'loading';
      render();
    }
    void cache.fetch(uuid, hours).then((query) => {
      if (!current()) {
        return;
      }
      state.history = query;
      state.displayedHistoryRange = hours;
      state.historyStatus = 'ready';
      render();
      historyRefreshTimer = setTimeout(() => loadHistory(uuid, metric, hours, true), HISTORY_REFRESH_MS);
    }).catch((error: unknown) => {
      if (!current()) {
        return;
      }
      recheckAccess(error);
      state.historyStatus = 'error';
      render();
      historyRefreshTimer = setTimeout(() => loadHistory(uuid, metric, hours, true), 15_000);
    });
  };

  const loadRouteHistory = (route: Extract<Route, { type: 'detail' }>): void => {
    if (!route.metric) {
      void ensurePingTasks();
    }
    loadHistory(route.uuid, route.metric ?? 'latency', state.historyRange);
  };

  const startDetailLoads = (route: Extract<Route, { type: 'detail' }>): void => {
    loadStatusRecords(route.uuid);
    loadRouteHistory(route);
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
    && !target.closest('button, a, input, select, .chart-container, .node-switcher');

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
    const previousRoute = state.route;
    state.route = route;
    state.routeKey = key;
    if (route.type === 'detail' && previousRoute.type === 'nodes') {
      state.historyRange = storedLatencyRange();
    }
    clearHistoryRefresh();
    historyRequestId += 1;
    state.history = null;
    state.displayedHistoryRange = null;
    state.historyStatus = 'loading';
    if (route.type === 'detail' && previousRoute.type === 'detail' && route.uuid === previousRoute.uuid) {
      if (state.metadataStatus === 'ready') {
        loadRouteHistory(route);
      } else {
        render();
      }
      return;
    }
    state.visibleTaskIds = null;
    clearStatusRefresh();
    statusController?.abort();
    statusController = null;
    state.statusFine = null;
    state.statusCoarse = null;
    if (route.type === 'detail' && state.metadataStatus === 'ready') {
      startDetailLoads(route);
      return;
    }
    render();
  };

  const clearSessionData = (): void => {
    clearLegacyNodeCache();
    closeSwitcher();
    liveSocket?.stop();
    liveSocket = null;
    state.nodes = [];
    state.online.clear();
    state.reports.clear();
    state.lastUpdate = null;
    state.lastSnapshotTimestamp = null;
    state.tasks = [];
    state.tasksReady = false;
    pingTasksRequest = null;
    clearHistoryRefresh();
    historyRequestId += 1;
    historyCaches = newHistoryCaches();
    state.history = null;
    state.displayedHistoryRange = null;
    state.historyStatus = 'loading';
    state.visibleTaskIds = null;
    clearStatusRefresh();
    statusController?.abort();
    statusRequestId += 1;
    state.statusFine = null;
    state.statusCoarse = null;
    liveStatus.textContent = '';
  };

  const refreshMetadata = async (): Promise<void> => {
    metadataController?.abort();
    const controller = new AbortController();
    metadataController = controller;
    const requestId = ++metadataRequestId;
    try {
      const nodes = await fetchNodeMetadata(controller.signal);
      if (stopped || requestId !== metadataRequestId) {
        return;
      }
      const newlyAuthorized = state.metadataStatus !== 'ready';
      state.nodes = nodes;
      state.metadataStatus = 'ready';
      if (newlyAuthorized) {
        liveSocket = createLiveSocket({
          scope: 'all',
          onSnapshot: applySnapshot,
          onStatusChange: updateLiveConnection,
        });
        if (state.route.type === 'detail') {
          startDetailLoads(state.route);
        }
      }
    } catch (error: unknown) {
      if (stopped || requestId !== metadataRequestId) {
        return;
      }
      if (isAccessDenied(error)) {
        state.metadataStatus = 'denied';
        clearSessionData();
        render();
        return;
      }
      if (state.metadataStatus === 'loading') {
        state.metadataStatus = 'error';
      }
    } finally {
      if (metadataController === controller) {
        metadataController = null;
      }
    }
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
    } else if (state.metadataStatus === 'ready') {
      updateNodeRows(page, getNodeStates(), reconciled.changedUuids);
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
  refreshTimer = setInterval(() => {
    liveSocket?.request();
    // An offline node sends no reports, so keep its outage duration ticking.
    if (state.route.type === 'detail' && !state.online.has(state.route.uuid)) {
      updateCore();
    }
  }, LIVE_REFRESH_MS);
  const timestampTimer = setInterval(updateTimestamp, 1000);
  metadataTimer = setInterval(() => void refreshMetadata(), 60_000);
  state.routeKey = routeKey(state.route);
  render();

  return () => {
    stopped = true;
    clearInterval(timestampTimer);
    clearHistoryRefresh();
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

