import { type MetricTone } from './format';

export type TrafficDirection = {
  up: number | null;
  down: number | null;
};

export type TrafficLimitType = 'sum' | 'max' | 'min' | 'up' | 'down' | string;

export type TrafficPresentation = {
  limited: boolean;
  used: number | null;
  limit: number | null;
  ratio: number;
  tone: MetricTone;
};

function safeValue(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function calculateTrafficUsage(
  traffic: TrafficDirection,
  type: TrafficLimitType | null | undefined,
): number | null {
  const up = safeValue(traffic.up);
  const down = safeValue(traffic.down);
  switch (type) {
    case 'up':
      return up;
    case 'down':
      return down;
    case 'sum':
      return up === null || down === null ? null : up + down;
    case 'min':
      return up === null || down === null ? null : Math.min(up, down);
    case 'max':
    default:
      return up === null || down === null ? null : Math.max(up, down);
  }
}

export function trafficTone(ratio: number): MetricTone {
  return Number.isFinite(ratio) && ratio > 0.8 ? 'warning' : 'normal';
}

export function getTrafficPresentation(
  traffic: TrafficDirection,
  limit: number | null | undefined,
  type: TrafficLimitType | null | undefined,
): TrafficPresentation {
  const used = calculateTrafficUsage(traffic, type);
  const validLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : null;
  const ratio = validLimit === null || used === null ? 0 : Math.min(1, used / validLimit);
  return {
    limited: validLimit !== null,
    used,
    limit: validLimit,
    ratio,
    tone: trafficTone(ratio),
  };
}

