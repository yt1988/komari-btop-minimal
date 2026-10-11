import {
  createLiveSocket,
  fetchLatency,
  fetchNodeMetadata,
  fetchPingTasks,
  fetchPublicSettings,
} from './api/komari';
import type { LatencyQuery, LiveReport, NodeMetadata, NodeState, PingTask } from './domain';
import { formatTimestamp } from './format';
import { toggleVisibleTasks } from './latency';
import { legacyRoutePath, parseRoute as parseBrowserRoute, routePath, type Route } from './router';
import { renderDetailView, updateDetailCore } from './views/detail';
import { renderNodeList, updateNodeRows } from './views/nodes';

type LatencyStatus = 'loading' | 'ready' | 'error';

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

function sameResource(left: LiveReport['ram'], right: LiveReport['ram']): boolean {
  return left?.total === right?.total && left?.used === right?.used;
}

function sameNetwork(left: LiveReport['network'], right: LiveReport['network']): boolean {
  return left?.up === right?.up
    && left?.down === right?.down
    && left?.totalUp === right?.totalUp
    && left?.totalDown === right?.totalDown;
}

function liveReportChanged(previous: LiveReport | undefined, next: LiveReport): boolean {
  return previous?.cpuUsage !== next.cpuUsage
    || !sameResource(previous?.ram ?? null, next.ram)
    || !sameResource(previous?.disk ?? null, next.disk)
    || !sameNetwork(previous?.network ?? null, next.network);
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

function allTaskIds(state: ApplicationState, uuid: string): string[] {
  const ids = state.tasks
    .filter((task) => task.clients.includes(uuid))
    .map((task) => task.id);
  for (const series of state.latency?.series ?? []) {
    if (!ids.includes(series.taskId)) {
      ids.push(series.taskId);
    }
  }
  return ids;
}

export function startApp(root: HTMLElement): () => void {
  const migratedPath = legacyRoutePath(window.location.hash);
  if (migratedPath !== null) {
    window.history.replaceState(null, '', migratedPath);
  }
  root.innerHTML = '<div class="terminal"><header class="header"><div><span class="prompt" data-role="site-name">Komari</span>:~$ nodes</div><div class="header-right" data-role="last-update">last update: --</div></header><main data-role="page"></main></div>';
  const page = root.querySelector<HTMLElement>('[data-role="page"]');
  const timestamp = root.querySelector<HTMLElement>('[data-role="last-update"]');
  const siteName = root.querySelector<HTMLElement>('[data-role="site-name"]');
  if (!page || !timestamp || !siteName) {
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
    route: currentRoute(),
    routeKey: '',
    latencyRange: 24,
    latency: null,
    latencyStatus: 'loading',
    visibleTaskIds: null,
  };
  let latencyController: AbortController | null = null;
  let latencyRequestId = 0;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let metadataTimer: ReturnType<typeof setInterval> | null = null;
  let liveSocket: ReturnType<typeof createLiveSocket> | null = null;
  let pingTasksRequest: Promise<PingTask[]> | null = null;

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
      if (!stopped) {
        state.tasksReady = true;
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
    renderDetailView(page, {
      node: getCurrentNode(),
      tasks: state.tasks,
      latency: state.latency,
      latencyState: state.latencyStatus,
      latencyRange: state.latencyRange,
      visibleTaskIds: visible,
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
        onTaskToggle: (taskId) => {
            const currentIds = allTaskIds(state, detailRoute.uuid);
          const currentVisible = state.visibleTaskIds === null ? currentIds : state.visibleTaskIds;
          state.visibleTaskIds = toggleVisibleTasks(currentIds, currentVisible, taskId);
          render();
        },
      },
    });
  };

  const loadLatency = (uuid: string, hours: number): void => {
    latencyController?.abort();
    const requestId = ++latencyRequestId;
    latencyController = new AbortController();
    state.latency = null;
    state.latencyStatus = 'loading';
    render();
    void fetchLatency(uuid, hours, latencyController.signal).then((query) => {
      if (stopped || requestId !== latencyRequestId || state.route.type !== 'detail' || state.route.uuid !== uuid || state.latencyRange !== hours) {
        return;
      }
      state.latency = query;
      state.latencyStatus = 'ready';
      render();
    }).catch((error: unknown) => {
      if (stopped || requestId !== latencyRequestId || (error instanceof DOMException && error.name === 'AbortError')) {
        return;
      }
      state.latency = null;
      state.latencyStatus = 'error';
      render();
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
    latencyController?.abort();
    state.latency = null;
    state.latencyRange = 24;
    state.latencyStatus = 'loading';
    state.visibleTaskIds = null;
    if (route.type === 'detail' && state.metadataReady && state.nodes.some((node) => node.uuid === route.uuid)) {
      void ensurePingTasks();
      loadLatency(route.uuid, state.latencyRange);
    } else {
      render();
    }
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
    }
    const nodesResult = await Promise.allSettled([fetchNodeMetadata()]);
    if (stopped) {
      return;
    }
    const nodeResult = nodesResult[0];
    if (nodeResult?.status === 'fulfilled') {
      state.nodes = nodeResult.value;
      nodeMetadataCache = state.nodes;
      try {
        window.sessionStorage.setItem('komari-btop-minimal:nodes:v1', JSON.stringify(state.nodes));
      } catch {
      }
      state.metadataFailed = false;
    } else {
      state.metadataFailed = state.nodes.length === 0;
    }
    state.metadataReady = true;
    if (state.selectedGroup !== 'all' && !state.nodes.some((node) => node.group.trim() === state.selectedGroup)) {
      state.selectedGroup = 'all';
    }
    const route = state.route;
    if (route.type === 'detail' && state.nodes.some((node) => node.uuid === route.uuid) && latencyController === null) {
      void ensurePingTasks();
      loadLatency(route.uuid, state.latencyRange);
      return;
    }
    render();
  };

  const applySnapshot = (snapshot: { online: string[]; data: Record<string, LiveReport> }): void => {
    const changedUuids = new Set<string>();
    const nextOnline = new Set(snapshot.online);
    for (const uuid of new Set([...state.online, ...nextOnline])) {
      if (state.online.has(uuid) !== nextOnline.has(uuid)) {
        changedUuids.add(uuid);
      }
    }
    state.online = new Set(snapshot.online);
    for (const [uuid, report] of Object.entries(snapshot.data)) {
      if (liveReportChanged(state.reports.get(uuid), report)) {
        changedUuids.add(uuid);
      }
      state.reports.set(uuid, report);
    }
    state.lastUpdate = Date.now();
    updateTimestamp();
    if (state.route.type === 'detail') {
      const core = page.querySelector<HTMLElement>('.detail-core');
      if (core) {
        updateDetailCore(core, getCurrentNode());
      }
    } else if (state.metadataReady) {
      updateNodeRows(page, getNodeStates(), nodeHandlers, changedUuids);
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
    latencyController?.abort();
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

