export type ResourceUsage = {
  total: number;
  used: number;
};

export type NetworkUsage = {
  up: number;
  down: number;
  totalUp: number;
  totalDown: number;
};

export type NodeMetadata = {
  uuid: string;
  name: string;
  group: string;
  memTotal: number;
  diskTotal: number;
  trafficLimit: number;
  trafficLimitType: string;
};

export type LiveReport = {
  cpuUsage: number | null;
  ram: ResourceUsage | null;
  disk: ResourceUsage | null;
  network: NetworkUsage | null;
  updatedAt: number | null;
};

export type LiveSnapshot = {
  online: string[];
  data: Record<string, LiveReport>;
};

export type NodeState = {
  metadata: NodeMetadata;
  online: boolean;
  report: LiveReport | null;
  lastReportAt: number | null;
};

export type PingTask = {
  id: string;
  name: string;
  clients: string[];
  defaultOn: boolean;
  type: string;
  interval: number;
};

export type LatencyPoint = {
  timestamp: number;
  value: number | null;
};

export type LatencySeries = {
  taskId: string;
  label: string;
  points: LatencyPoint[];
};

export type LatencyQuery = {
  start: number;
  end: number;
  intervalSeconds: number;
  series: LatencySeries[];
};

