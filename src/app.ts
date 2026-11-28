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
import { liveReportChanged, reconcileLiveSnapshot } from './live';
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
import { STATUS_FINE_HOURS, STATUS_HISTORY_HOURS, createOutageHistory } from './statusHistory';
import { setChartOffline } from './views/chart';
import { dismissMetricMenuOutside, renderDetailView, updateDetailCore } from './views/detail';
import { renderNodeList, updateNodeRows } from './views/nodes';
import { renderNodeSwitcher, updateNodeSwitcher } from './views/switcher';
import type { StatusView } from './views/status';

const DEFAULT_LATENCY_HOURS = 24;
const HISTORY_REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 3000;
const LIVE_STALE_MS = 3 * LIVE_REFRESH_MS;
const HIDDEN_SOCKET_GRACE_MS = 30_000;
const METADATA_REFRESH_MS = 60_000;

type HistoryStatus = 'loading' | 'ready' | 'error';
type MetadataStatus = 'loading' | 'ready' | 'denied';

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

  const accessMessage = document.createElement('div');
  accessMessage.className = 'empty-state';
  const accessText = document.createElement('span');
  accessText.setAttribute('role', 'status');
  const accessRetry = document.createElement('button');
  accessRetry.type = 'button';
  accessRetry.className = 'retry';
  accessMessage.append(accessText, ' ', accessRetry);

  const chinese = /^zh(?:-|$)/i.test(navigator.language);
  accessRetry.textContent = chinese ? '重新连接' : 'Reconnect';
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
  let metadataByUuid = new Map<string, NodeMetadata>();
  const knownOnlineState = new Set<string>();
  let foreground = false;
  let accessRetryAt = 0;
  let accessVerifiedAt: number | null = null;
  let foregroundAt = 0;
  let renderedRouteKey: string | null = null;
  let lastTick = Date.now();
  let hiddenAt: number | null = null;
  let socketCloseTimer: ReturnType<typeof setTimeout> | null = null;
  let foregroundFrame: number | null = null;
  let timestampTimer: ReturnType<typeof setInterval> | null = null;
  let siteNameLoaded = false;
  let siteController: AbortController | null = null;
  let tasksController: AbortController | null = null;
  let historyPending = false;
  let statusController: AbortController | null = null;
  let statusRequestId = 0;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let statusRefreshAt = 0;
  let statusCoarseAt = 0;
  const newHistoryCaches = () => ({
    latency: createLatencyCache(fetchLatency),
    cpu: createLatencyCache((uuid, hours, signal) => fetchResourceHistory(uuid, hours, 'cpu', signal)),
    mem: createLatencyCache((uuid, hours, signal) => fetchResourceHistory(uuid, hours, 'mem', signal)),
    network: createLatencyCache((uuid, hours, signal) => fetchResourceHistory(uuid, hours, 'network', signal)),
  });
  let historyCaches = newHistoryCaches();
  let historyRequestId = 0;
  let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let metadataController: AbortController | null = null;
  let metadataRequestId = 0;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let metadataTimer: ReturnType<typeof setTimeout> | null = null;
  let liveSocket: ReturnType<typeof createLiveSocket> | null = null;
  let pingTasksRequest: Promise<PingTask[]> | null = null;
  const latencyColorRegistry: NodeLatencyColorRegistry = (() => {
    try {
      return parseLatencyColorRegistry(JSON.parse(window.sessionStorage.getItem('komari-btop-minimal:latency-colors:v1') ?? '[]'));
    } catch {
      return new Map();
    }
  })();

  let serializedColors: string | null = null;
  const persistLatencyColors = (): void => {
    try {
      const value = JSON.stringify(serializeLatencyColorRegistry(latencyColorRegistry));
      if (value === serializedColors) return;
      window.sessionStorage.setItem('komari-btop-minimal:latency-colors:v1', value);
      serializedColors = value;
    } catch {
    }
  };

  // Before the first snapshot nothing is known about liveness. Treating nodes as
  // online then renders neutral "--" placeholders instead of a red offline flash
  // over the node list; the status dot itself shows the pending state.
  const nodeState = (metadata: NodeMetadata): NodeState => {
    const live = knownOnlineState.has(metadata.uuid);
    const report = state.reports.get(metadata.uuid) ?? null;
    return {
      metadata,
      live,
      online: !live || state.online.has(metadata.uuid),
      report,
      lastReportAt: report?.updatedAt ?? null,
    };
  };
  const getNodeStates = (): NodeState[] => state.nodes.map(nodeState);
  const getCurrentNode = (): NodeState | null => {
    if (state.route.type !== 'detail') return null;
    const metadata = metadataByUuid.get(state.route.uuid);
    return metadata ? nodeState(metadata) : null;
  };

  let outageHistory = createOutageHistory();
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
    const outages = node && state.statusCoarse !== null ? outageHistory(input) : null;
    return {
      outages,
      now,
    };
  };

  const updateCore = (redrawOutages = false): void => {
    const core = page.querySelector<HTMLElement>('.detail-core');
    if (!core || state.route.type !== 'detail') return;
    const node = getCurrentNode();
    const view = getStatusView(node);
    updateDetailCore(core, node, view);
    if (redrawOutages) {
      page.querySelectorAll<HTMLElement>('.chart-container').forEach((chart) => setChartOffline(chart, view.outages ?? []));
    }
  };

  // Records arrive after the chart, so only its offline bands and the status need to change.
  const applyOutages = (): void => updateCore(true);

  const clearStatusRefresh = (): void => {
    if (statusRefreshTimer !== null) {
      clearTimeout(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  const scheduleStatusRefresh = (uuid: string, delay: number): void => {
    clearStatusRefresh();
    statusRefreshAt = Date.now() + delay;
    statusRefreshTimer = setTimeout(() => loadStatusRecords(uuid), delay);
  };

  /**
   * Loads the record times behind the outage list and chart offline bands:
   * per-minute data for the last 6h every call, five-minute data for 24h at
   * most every 10 minutes.
   */
  const loadStatusRecords = (uuid: string): void => {
    if (!foreground || state.metadataStatus !== 'ready' || !metadataByUuid.has(uuid)) return;
    clearStatusRefresh();
    statusRefreshAt = 0;
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
      scheduleStatusRefresh(uuid, 120_000);
    }).catch((error: unknown) => {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (stopped || requestId !== statusRequestId || aborted) {
        return;
      }
      if (recheckAccess(error)) return;
      scheduleStatusRefresh(uuid, 60_000);
    }).finally(() => {
      if (statusController === controller) {
        statusController = null;
      }
    });
  };

  const announce = (message: string): void => {
    liveStatus.textContent = message;
  };

  let formattedUpdateAt: number | null | undefined;
  let formattedUpdate = '';
  const updateTimestamp = (): void => {
    if (formattedUpdateAt !== state.lastUpdate) {
      formattedUpdateAt = state.lastUpdate;
      formattedUpdate = formatRefreshTime(formattedUpdateAt);
    }
    const age = Date.now() - (state.lastUpdate ?? startedAt);
    const stale = state.metadataStatus === 'ready' && age >= LIVE_STALE_MS;
    const seconds = Math.floor(age / 1000);
    const staleLabel = state.lastUpdate === null
      ? (chinese ? '等待实时数据' : 'waiting for live data')
      : (chinese ? `数据已过期 · ${seconds} 秒前` : `data stale · ${seconds}s ago`);
    const text = stale ? staleLabel : formattedUpdate;
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

  const metadataRefreshDelay = (now: number): number => {
    if (accessVerifiedAt === null || now < accessVerifiedAt) return 0;
    return Math.max(0, accessVerifiedAt + METADATA_REFRESH_MS - now);
  };

  const updateLiveConnection = (status: LiveSocketStatus): void => {
    const previous = state.liveConnection;
    state.liveConnection = status;
    if (foreground && state.metadataStatus === 'ready' && status === 'reconnecting' && previous !== 'reconnecting') {
      announce('reconnecting live telemetry');
      const now = Date.now();
      if (now - foregroundAt >= LIVE_REFRESH_MS || metadataRefreshDelay(now) === 0) {
        void refreshMetadata();
      }
    }
  };

  const recheckAccess = (error: unknown): boolean => {
    if (!foreground || stopped || !isAccessDenied(error)) return false;
    metadataController?.abort();
    metadataController = null;
    metadataRequestId += 1;
    accessVerifiedAt = null;
    state.metadataStatus = 'denied';
    clearSessionData();
    render();
    return true;
  };

  const loadSiteName = async (): Promise<void> => {
    if (siteNameLoaded || siteController) return;
    const controller = new AbortController();
    siteController = controller;
    try {
      const settings = await fetchPublicSettings(controller.signal);
      if (!controller.signal.aborted && !stopped) {
        siteName.textContent = settings.siteName;
        siteNameLoaded = true;
      }
    } catch {
    } finally {
      if (siteController === controller) siteController = null;
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
      if (!foreground || historyPending || state.metadataStatus !== 'ready' || !metadataByUuid.has(uuid)) return;
      const hours = state.route.type === 'detail' ? state.historyRange : storedLatencyRange();
      historyCaches.latency.prefetch(uuid, hours, HISTORY_REFRESH_MS, recheckAccess);
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
    const controller = new AbortController();
    tasksController = controller;
    const request = fetchPingTasks(controller.signal).then((tasks) => {
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
        if (recheckAccess(error)) return [];
        if (!stopped && state.route.type === 'detail') {
          announce('latency targets unavailable; retrying when needed');
        }
      }
      return [];
    }).finally(() => {
      if (pingTasksRequest === request) {
        pingTasksRequest = null;
        tasksController = null;
      }
    });
    pingTasksRequest = request;
    return request;
  };

  const render = (): void => {
    state.route = currentRoute();
    updateTimestamp();
    if (!foreground || state.metadataStatus === 'loading') return;
    renderedRouteKey = routeKey(state.route);
    if (state.metadataStatus === 'denied') {
      const message = document.createElement('div');
      message.className = 'empty-state danger';
      message.setAttribute('role', 'alert');
      message.textContent = chinese ? '请登录，或获取新的分享链接。当前分享可能已失效。'
        : 'Sign in or get a new share link. Your current link may have expired.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'retry';
      retry.textContent = chinese ? '重试' : 'retry';
      retry.addEventListener('click', () => void refreshMetadata(true));
      message.append(' ', retry);
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

  const cancelHistory = (metric?: HistoryMetric, uuid?: string, hours?: number): void => {
    clearHistoryRefresh();
    historyRequestId += 1;
    historyPending = false;
    for (const [key, cache] of Object.entries(historyCaches)) {
      if (key === metric) cache.cancelExcept(uuid, hours);
      else cache.cancelExcept();
    }
  };

  /**
   * Shows cached data for the node and range at once when there is any, then
   * refreshes it; `refresh` skips the cache for the periodic update.
   */
  const loadHistory = (uuid: string, metric: HistoryMetric, hours: number, refresh = false): void => {
    if (!foreground || state.metadataStatus !== 'ready' || !metadataByUuid.has(uuid)) return;
    cancelHistory(metric, uuid, hours);
    const requestId = historyRequestId;
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
    historyPending = true;
    void cache.fetch(uuid, hours).then((query) => {
      if (!current()) {
        return;
      }
      historyPending = false;
      state.history = query;
      state.displayedHistoryRange = hours;
      state.historyStatus = 'ready';
      render();
      historyRefreshTimer = setTimeout(() => loadHistory(uuid, metric, hours, true), HISTORY_REFRESH_MS);
    }).catch((error: unknown) => {
      if (!current()) {
        return;
      }
      historyPending = false;
      if (recheckAccess(error)) return;
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
    if (!metadataByUuid.has(route.uuid)) return;
    if (!statusController && statusRefreshTimer === null) {
      const remaining = statusRefreshAt - Date.now();
      if (remaining > 0 && remaining <= 120_000) scheduleStatusRefresh(route.uuid, remaining);
      else loadStatusRecords(route.uuid);
    }
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
    if (!foreground || state.metadataStatus !== 'ready' || state.route.type !== 'detail') return null;
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
    liveSocket?.request();
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

  const handleMetricPointerDown = (event: PointerEvent): void => {
    if (event.isTrusted && !foreground) resumeForeground(true);
    dismissMetricMenuOutside(page, event.target);
  };

  const handleDocumentMouseDown = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (switcher && !switcher.contains(target) && !target?.closest('[data-role="node-switch"]')) {
      closeSwitcher();
    }
  };

  const handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.isTrusted && !foreground) resumeForeground(true);
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
    if (route.type === 'nodes' || (route.type === 'detail' && !metadataByUuid.has(route.uuid))) cancelHistory();
    if (route.type !== previousRoute.type || (route.type === 'detail' && previousRoute.type === 'detail' && route.uuid !== previousRoute.uuid)) {
      liveSocket?.request();
    }
    state.history = null;
    state.displayedHistoryRange = null;
    state.historyStatus = 'loading';
    if (route.type === 'detail' && previousRoute.type === 'detail' && route.uuid === previousRoute.uuid) {
      if (foreground && state.metadataStatus === 'ready' && metadataByUuid.has(route.uuid)) {
        loadRouteHistory(route);
      } else {
        render();
      }
      return;
    }
    state.visibleTaskIds = null;
    clearStatusRefresh();
    statusController?.abort();
    statusRequestId += 1;
    statusController = null;
    state.statusFine = null;
    state.statusCoarse = null;
    statusRefreshAt = 0;
    outageHistory = createOutageHistory();
    if (route.type === 'detail' && foreground && state.metadataStatus === 'ready') {
      startDetailLoads(route);
    }
    render();
  };

  const clearSessionData = (): void => {
    clearLegacyNodeCache();
    closeSwitcher();
    stopLiveSocket();
    state.nodes = [];
    latencyColorRegistry.clear();
    persistLatencyColors();
    metadataByUuid.clear();
    knownOnlineState.clear();
    state.online.clear();
    state.reports.clear();
    state.lastUpdate = null;
    state.lastSnapshotTimestamp = null;
    state.tasks = [];
    state.tasksReady = false;
    tasksController?.abort();
    tasksController = null;
    pingTasksRequest = null;
    cancelHistory();
    historyCaches = newHistoryCaches();
    state.history = null;
    state.displayedHistoryRange = null;
    state.historyStatus = 'loading';
    state.visibleTaskIds = null;
    clearStatusRefresh();
    statusController?.abort();
    statusRequestId += 1;
    statusController = null;
    state.statusFine = null;
    state.statusCoarse = null;
    statusRefreshAt = 0;
    outageHistory = createOutageHistory();
    liveStatus.textContent = '';
  };

  const requestedNode = (): string | undefined =>
    state.route.type === 'detail' && !switcher && metadataByUuid.has(state.route.uuid) ? state.route.uuid : undefined;

  const resumeLiveSocket = (): void => {
    if (liveSocket) {
      liveSocket.resume();
      return;
    }
    liveSocket = createLiveSocket({
      scope: 'all',
      nodeUuid: requestedNode,
      onSnapshot: applySnapshot,
      onStatusChange: updateLiveConnection,
    });
  };

  const refreshMetadata = async (immediate = false): Promise<void> => {
    if (!foreground || metadataController) return;
    if (state.metadataStatus === 'loading') {
      if (!immediate && Date.now() < accessRetryAt) return;
      showStartupStatus('checking');
    }
    const controller = new AbortController();
    metadataController = controller;
    const requestId = ++metadataRequestId;
    try {
      const nodes = await fetchNodeMetadata(controller.signal);
      if (stopped || requestId !== metadataRequestId) return;
      const initialAccess = state.metadataStatus !== 'ready';
      const changed = JSON.stringify(state.nodes) !== JSON.stringify(nodes);
      if (initialAccess || changed) {
        const allowed = new Set(nodes.map(({ uuid }) => uuid));
        for (const uuid of latencyColorRegistry.keys()) {
          if (!allowed.has(uuid)) latencyColorRegistry.delete(uuid);
        }
        persistLatencyColors();
      }
      if (changed) {
        const nextMetadata = new Map(nodes.map((node) => [node.uuid, node]));
        const removed = state.nodes.some(({ uuid }) => !nextMetadata.has(uuid));
        if (removed) {
          for (const uuid of metadataByUuid.keys()) {
            if (nextMetadata.has(uuid)) continue;
            state.reports.delete(uuid);
            state.online.delete(uuid);
            knownOnlineState.delete(uuid);
          }
          state.lastSnapshotTimestamp = null;
          cancelHistory();
          historyCaches = newHistoryCaches();
          if (state.route.type === 'detail' && !nextMetadata.has(state.route.uuid)) {
            closeSwitcher();
            clearStatusRefresh();
            statusRequestId += 1;
            statusController?.abort();
            statusController = null;
            state.history = null;
            state.statusFine = null;
            state.statusCoarse = null;
            statusRefreshAt = 0;
            outageHistory = createOutageHistory();
            state.displayedHistoryRange = null;
          }
        }
        state.nodes = nodes;
        metadataByUuid = nextMetadata;
        if (switcher) updateNodeSwitcher(switcher, getNodeStates());
        if (state.selectedGroup !== 'all' && !nodes.some((node) => node.group.trim() === state.selectedGroup)) {
          state.selectedGroup = 'all';
        }
      }
      state.metadataStatus = 'ready';
      accessVerifiedAt = Date.now();
      if (initialAccess || changed) render();
      if (initialAccess || !liveSocket) resumeLiveSocket();
      if ((initialAccess || changed) && state.route.type === 'detail') startDetailLoads(state.route);
    } catch (error: unknown) {
      if (stopped || requestId !== metadataRequestId || recheckAccess(error)) return;
      if (state.metadataStatus === 'loading') {
        accessRetryAt = Date.now() + LIVE_REFRESH_MS;
        showStartupStatus('retrying');
      }
    } finally {
      if (metadataController === controller) metadataController = null;
    }
  };

  const applySnapshot = (snapshot: LiveSnapshot, uuid: string | undefined): void => {
    if (!foreground || state.metadataStatus !== 'ready') return;
    const changedUuids = new Set<string>();
    let onlineChangedUuids: Set<string>;
    const hadSnapshot = state.lastUpdate !== null;

    if (uuid) {
      if (!metadataByUuid.has(uuid)) return;
      const previous = state.reports.get(uuid);
      const next = Object.hasOwn(snapshot.data, uuid) ? snapshot.data[uuid] : undefined;
      if (previous?.updatedAt != null && next?.updatedAt != null && next.updatedAt < previous.updatedAt) return;
      const isOnline = snapshot.online.includes(uuid);
      onlineChangedUuids = new Set();
      if (knownOnlineState.has(uuid) && state.online.has(uuid) !== isOnline) onlineChangedUuids.add(uuid);
      if (liveReportChanged(previous, next) || !knownOnlineState.has(uuid) || onlineChangedUuids.size > 0) {
        changedUuids.add(uuid);
      }
      if (isOnline) state.online.add(uuid);
      else state.online.delete(uuid);
      if (next) state.reports.set(uuid, next);
      // Keep the last report of an offline node for its traffic totals and outage start.
      knownOnlineState.add(uuid);
    } else {
      const authorizedSnapshot = {
        online: snapshot.online.filter((id) => metadataByUuid.has(id)),
        data: Object.fromEntries(Object.entries(snapshot.data).filter(([id]) => metadataByUuid.has(id))),
      };
      const reconciled = reconcileLiveSnapshot(state.online, state.reports, authorizedSnapshot, state.lastSnapshotTimestamp);
      if (!reconciled) return;
      state.online = reconciled.online;
      state.reports = reconciled.reports;
      state.lastSnapshotTimestamp = reconciled.latestTimestamp ?? state.lastSnapshotTimestamp;
      onlineChangedUuids = reconciled.onlineChangedUuids;
      for (const id of reconciled.changedUuids) changedUuids.add(id);
      for (const { uuid: id } of state.nodes) {
        if (!knownOnlineState.has(id)) {
          onlineChangedUuids.delete(id);
          changedUuids.add(id);
          knownOnlineState.add(id);
        }
      }
      if (switcher) updateNodeSwitcher(switcher, getNodeStates());
    }

    state.lastUpdate = Date.now();
    updateTimestamp();
    const route = state.route;
    if (hadSnapshot && onlineChangedUuids.size > 0) {
      const changed = route.type === 'detail'
        ? onlineChangedUuids.has(route.uuid) ? route.uuid : null
        : onlineChangedUuids.size === 1 ? [...onlineChangedUuids][0]! : null;
      if (changed) {
        announce(`${metadataByUuid.get(changed)?.name ?? 'node'} is ${state.online.has(changed) ? 'online' : 'offline'}`);
      } else if (route.type === 'nodes') {
        announce(`${onlineChangedUuids.size} node availability changes`);
      }
    }
    if (route.type === 'detail') {
      if (!changedUuids.has(route.uuid)) return;
      if (onlineChangedUuids.has(route.uuid)) {
        applyOutages();
        statusRequestId += 1;
        statusController?.abort();
        statusController = null;
        scheduleStatusRefresh(route.uuid, 75_000);
      } else {
        updateCore();
      }
    } else {
      const changed = [...changedUuids].flatMap((id) => {
        const metadata = metadataByUuid.get(id);
        return metadata ? [nodeState(metadata)] : [];
      });
      updateNodeRows(page, changed, changedUuids);
    }
  };

  const showStartupStatus = (phase: 'paused' | 'checking' | 'retrying'): void => {
    if (state.metadataStatus !== 'loading') return;
    if (page.firstElementChild !== accessMessage) page.replaceChildren(accessMessage);
    accessRetry.hidden = phase === 'checking';
    const message = phase === 'paused'
      ? (chinese ? '更新已暂停，返回后自动连接。' : 'Updates paused. Reconnecting when you return.')
      : phase === 'retrying'
        ? (chinese ? '暂时无法连接，正在重试。' : 'Unable to connect. Retrying.')
        : (chinese ? '正在确认访问权限…' : 'Checking access…');
    if (accessText.textContent !== message) accessText.textContent = message;
  };

  const stopLiveSocket = (): void => {
    if (socketCloseTimer !== null) clearTimeout(socketCloseTimer);
    socketCloseTimer = null;
    liveSocket?.stop();
    liveSocket = null;
  };

  const suspendRequests = (): void => {
    cancelHistory();
    clearStatusRefresh();
    statusRequestId += 1;
    statusController?.abort();
    statusController = null;
    metadataRequestId += 1;
    metadataController?.abort();
    metadataController = null;
    tasksController?.abort();
    tasksController = null;
    pingTasksRequest = null;
    siteController?.abort();
    siteController = null;
  };

  const pauseForeground = (): void => {
    if (!foreground) return;
    foreground = false;
    hiddenAt = Date.now();
    showStartupStatus('paused');
    if (refreshTimer !== null) clearInterval(refreshTimer);
    if (metadataTimer !== null) clearTimeout(metadataTimer);
    if (timestampTimer !== null) clearInterval(timestampTimer);
    refreshTimer = metadataTimer = timestampTimer = null;
    liveSocket?.pause();
    suspendRequests();
    if (liveSocket) socketCloseTimer = setTimeout(stopLiveSocket, HIDDEN_SOCKET_GRACE_MS);
  };

  const restartLiveUpdates = (): void => {
    suspendRequests();
    stopLiveSocket();
    updateTimestamp();
    if (state.metadataStatus === 'ready') {
      resumeLiveSocket();
      if (state.route.type === 'detail') startDetailLoads(state.route);
    }
    void refreshMetadata(true);
  };

  const tick = (): void => {
    const now = Date.now();
    const delayed = now - lastTick >= LIVE_STALE_MS;
    lastTick = now;
    if (state.metadataStatus === 'loading') {
      void refreshMetadata();
      return;
    }
    if (state.metadataStatus !== 'ready') return;
    if (delayed && navigator.onLine) {
      restartLiveUpdates();
      return;
    }
    liveSocket?.request();
    if (state.route.type === 'detail' && !state.online.has(state.route.uuid)) updateCore();
  };

  const scheduleMetadataRefresh = (delay: number): void => {
    metadataTimer = setTimeout(() => {
      if (!foreground) return;
      void refreshMetadata();
      scheduleMetadataRefresh(METADATA_REFRESH_MS);
    }, delay);
  };

  const resumeForeground = (userRequested = false): void => {
    if (foreground || (!userRequested && document.hidden) || stopped) return;
    const now = Date.now();
    const metadataDueIn = metadataRefreshDelay(now);
    if (metadataDueIn === 0 || (hiddenAt !== null && now - hiddenAt >= HIDDEN_SOCKET_GRACE_MS)) {
      stopLiveSocket();
    }
    if (socketCloseTimer !== null) clearTimeout(socketCloseTimer);
    socketCloseTimer = null;
    foreground = true;
    foregroundAt = lastTick = now;
    void loadSiteName();
    updateTimestamp();
    if (state.metadataStatus === 'ready') {
      // Keep the rendered view mounted while the server refreshes data and access.
      if (renderedRouteKey !== state.routeKey) render();
      resumeLiveSocket();
      if (state.route.type === 'detail') startDetailLoads(state.route);
      scheduleMetadataRefresh(metadataDueIn);
    } else {
      accessRetryAt = 0;
      void refreshMetadata();
      scheduleMetadataRefresh(METADATA_REFRESH_MS);
    }
    refreshTimer = setInterval(tick, LIVE_REFRESH_MS);
    timestampTimer = setInterval(updateTimestamp, 1000);
  };

  const onVisibility = (): void => {
    if (document.hidden) pauseForeground();
    else resumeForeground();
  };

  const onForegroundSignal = (): void => {
    resumeForeground();
    if (foreground || stopped || foregroundFrame !== null) return;
    // Check again at the next paint if focus arrived before the visibility state changed.
    foregroundFrame = requestAnimationFrame(() => {
      foregroundFrame = null;
      resumeForeground();
    });
  };

  const onPageHide = (): void => {
    pauseForeground();
    stopLiveSocket();
  };

  const onFreeze = (): void => {
    if (document.hidden) onPageHide();
  };

  const onOnline = (): void => {
    if (document.hidden) return;
    if (!foreground) {
      resumeForeground();
      return;
    }
    if (state.metadataStatus !== 'ready') {
      void refreshMetadata(true);
      return;
    }
    if (Date.now() - foregroundAt >= LIVE_REFRESH_MS) restartLiveUpdates();
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
  document.addEventListener('pointerdown', handleMetricPointerDown);
  document.addEventListener('mousedown', handleDocumentMouseDown);
  document.addEventListener('keydown', handleDocumentKeyDown);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('freeze', onFreeze);
  document.addEventListener('resume', onVisibility);
  window.addEventListener('pageshow', onForegroundSignal);
  window.addEventListener('focus', onForegroundSignal);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  accessRetry.addEventListener('click', (event) => {
    if (foreground) void refreshMetadata(true);
    else resumeForeground(event.isTrusted);
  });
  state.routeKey = routeKey(state.route);
  showStartupStatus('paused');
  resumeForeground();

  return () => {
    stopped = true;
    pauseForeground();
    stopLiveSocket();
    if (foregroundFrame !== null) cancelAnimationFrame(foregroundFrame);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('freeze', onFreeze);
    document.removeEventListener('resume', onVisibility);
    window.removeEventListener('pageshow', onForegroundSignal);
    window.removeEventListener('focus', onForegroundSignal);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('popstate', handleRouteChange);
    window.removeEventListener('hashchange', handleRouteChange);
    page.removeEventListener('click', handlePageClick);
    document.removeEventListener('mousedown', handlePageMouseDown);
    document.removeEventListener('dblclick', handlePageDoubleClick);
    document.removeEventListener('pointerdown', handleMetricPointerDown);
    document.removeEventListener('mousedown', handleDocumentMouseDown);
    document.removeEventListener('keydown', handleDocumentKeyDown);
  };
}

