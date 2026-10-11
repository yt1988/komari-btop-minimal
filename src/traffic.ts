import { type MetricTone } from './format';

export type TrafficDirection = {
  up: number | null;
  down: number | null;
};

export type TrafficLimitType = 'sum' | 'max' | 'min' | 'up' | 'down' | string;

export type TrafficPresentation = {
  limited: boolean;
  used: number;
  limit: number | null;
  ratio: number;
  tone: MetricTone;
};

function safeValue(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function calculateTrafficUsage(
  traffic: TrafficDirection,
  type: TrafficLimitType | null | undefined,
): number {
  const up = safeValue(traffic.up);
  const down = safeValue(traffic.down);
  switch (type) {
    case 'sum':
      return up + down;
    case 'min':
      return Math.min(up, down);
    case 'up':
      return up;
    case 'down':
      return down;
    case 'max':
    default:
      return Math.max(up, down);
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
  const ratio = validLimit === null ? 0 : Math.min(1, used / validLimit);
  return {
    limited: validLimit !== null,
    used,
    limit: validLimit,
    ratio,
    tone: trafficTone(ratio),
  };
}

