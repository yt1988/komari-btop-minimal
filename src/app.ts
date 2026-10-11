import {
  createLiveSocket,
  fetchLatency,
  fetchNodeMetadata,
  fetchPingTasks,
} from './api/komari';
import type { LatencyQuery, LiveReport, NodeMetadata, NodeState, PingTask } from './domain';
import { formatTimestamp } from './format';
import { toggleVisibleTasks } from './latency';
import { renderDetailView, updateDetailCore } from './views/detail';
import { renderNodeList } from './views/nodes';

type Route = { type: 'nodes' } | { type: 'detail'; uuid: string };

type LatencyStatus = 'loading' | 'ready' | 'error';

type ApplicationState = {
  nodes: NodeMetadata[];
  reports: Map<string, LiveReport>;
  online: Set<string>;
  tasks: PingTask[];
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

function parseRoute(): Route {
  const hash = window.location.hash || '#/nodes';
  const match = hash.match(/^#\/nodes(?:\/([^/?#]+))?\/?$/);
  if (!match?.[1]) {
    return { type: 'nodes' };
  }
  try {
    return { type: 'detail', uuid: decodeURIComponent(match[1]) };
  } catch {
    return { type: 'detail', uuid: match[1] };
  }
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
  root.innerHTML = '<div class="terminal"><header class="header"><div><span class="prompt">visitor@komari:~$</span> nodes</div><div class="header-right" data-role="last-update">last update: --</div></header><main data-role="page"></main></div>';
  const page = root.querySelector<HTMLElement>('[data-role="page"]');
  const timestamp = root.querySelector<HTMLElement>('[data-role="last-update"]');
  if (!page || !timestamp) {
    throw new Error('Missing application shell elements');
  }

  const state: ApplicationState = {
    nodes: [],
    reports: new Map(),
    online: new Set(),
    tasks: [],
    metadataReady: false,
    metadataFailed: false,
    selectedGroup: 'all',
    lastUpdate: null,
    route: parseRoute(),
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

  const render = (): void => {
    state.route = parseRoute();
    updateTimestamp();
    if (!state.metadataReady && state.nodes.length === 0) {
      const loading = document.createElement('div');
      loading.className = 'empty-state muted';
      loading.textContent = 'loading nodes';
      page.replaceChildren(loading);
      return;
    }
    if (state.route.type === 'nodes') {
      renderNodeList(page, getNodeStates(), state.selectedGroup, {
        onGroupSelect: (group) => {
          state.selectedGroup = group;
          render();
        },
        onNodeSelect: (uuid) => {
          window.location.hash = `#/nodes/${encodeURIComponent(uuid)}`;
        },
      }, state.metadataFailed ? 'unable to load nodes' : 'no nodes');
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
    const currentRoute = state.route;
    renderDetailView(page, {
      node: getCurrentNode(),
      tasks: state.tasks,
      latency: state.latency,
      latencyState: state.latencyStatus,
      latencyRange: state.latencyRange,
      visibleTaskIds: visible,
      handlers: {
        onBack: () => {
          window.location.hash = '#/nodes';
        },
        onRangeChange: (hours) => {
          if (state.latencyRange === hours) {
            return;
          }
          state.latencyRange = hours;
          loadLatency(currentRoute.uuid, hours);
        },
        onTaskToggle: (taskId) => {
          const currentIds = allTaskIds(state, currentRoute.uuid);
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
    const route = parseRoute();
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
      loadLatency(route.uuid, state.latencyRange);
    } else {
      render();
    }
  };

  const refreshMetadata = async (): Promise<void> => {
    const [nodesResult, tasksResult] = await Promise.allSettled([fetchNodeMetadata(), fetchPingTasks()]);
    if (stopped) {
      return;
    }
    if (nodesResult.status === 'fulfilled') {
      state.nodes = nodesResult.value;
      state.metadataFailed = false;
    } else {
      state.metadataFailed = true;
    }
    if (tasksResult.status === 'fulfilled') {
      state.tasks = tasksResult.value;
    }
    state.metadataReady = true;
    if (state.selectedGroup !== 'all' && !state.nodes.some((node) => node.group.trim() === state.selectedGroup)) {
      state.selectedGroup = 'all';
    }
    const route = state.route;
    if (route.type === 'detail' && state.nodes.some((node) => node.uuid === route.uuid) && latencyController === null) {
      loadLatency(route.uuid, state.latencyRange);
      return;
    }
    render();
  };

  const applySnapshot = (snapshot: { online: string[]; data: Record<string, LiveReport> }): void => {
    state.online = new Set(snapshot.online);
    for (const [uuid, report] of Object.entries(snapshot.data)) {
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
      render();
    }
  };

  const handleRouteChange = (): void => {
    syncRoute();
  };

  window.addEventListener('hashchange', handleRouteChange);
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
    window.removeEventListener('hashchange', handleRouteChange);
  };
}

