import { describe, expect, it } from 'vitest';
import {
  LATENCY_RANGES,
  LATENCY_SERIES_COLORS,
  buildLatencyRuns,
  buildLatencySegments,
  formatLatencyReadout,
  latencyCeiling,
  latencySeriesColor,
  toggleVisibleTasks,
} from '../src/latency';
import {
  parseLatencyColorRegistry,
  reconcileLatencyColors,
  serializeLatencyColorRegistry,
} from '../src/latencyColors';

function assignLatencyColors(taskIds: readonly string[]) {
  return reconcileLatencyColors(new Map(), 'test-node', taskIds);
}

describe('latency selection and segmentation', () => {
  it('exposes the six exact ranges with 24h as the default', () => {
    expect(LATENCY_RANGES).toEqual([
      { label: '1h', hours: 1 },
      { label: '6h', hours: 6 },
      { label: '24h', hours: 24 },
      { label: '3d', hours: 72 },
      { label: '7d', hours: 168 },
      { label: '30d', hours: 720 },
    ]);
  });

  it('never allows an empty task selection', () => {
    expect(toggleVisibleTasks(['unicom', 'mobile'], ['unicom', 'mobile'], 'unicom')).toEqual(['unicom']);
    expect(toggleVisibleTasks(['unicom', 'mobile'], ['unicom'], 'unicom')).toEqual(['unicom', 'mobile']);
    expect(toggleVisibleTasks(['unicom', 'mobile', 'telecom'], ['unicom', 'mobile'], 'unicom')).toEqual(['mobile']);
    expect(toggleVisibleTasks(['unicom', 'mobile'], ['unicom'], 'mobile')).toEqual(['unicom', 'mobile']);
  });

  it('keeps a series continuous when it crosses latency thresholds', () => {
    const segments = buildLatencySegments([
      { timestamp: 0, value: 50 },
      { timestamp: 10, value: 250 },
    ], 100);
    expect(segments.map((segment) => [segment.from.timestamp, segment.to.timestamp])).toEqual([[0, 10]]);
    expect(latencyCeiling([{ timestamp: 0, value: 201 }])).toBe(300);
  });

  it('assigns three unique stable colors without hash collisions', () => {
    const registry = new Map();
    const initial = reconcileLatencyColors(registry, 'node-a', ['1', '4', '7']);
    expect(LATENCY_SERIES_COLORS).toEqual(['#3987e5', '#7046c7', '#a35229']);
    expect(new Set(initial.assignments.values()).size).toBe(3);
    expect(reconcileLatencyColors(registry, 'node-a', ['7', '1', '4']).assignments).toEqual(initial.assignments);
    expect(reconcileLatencyColors(registry, 'node-a', ['1', '7']).assignments.get('1')).toBe(initial.assignments.get('1'));
  });

  it('keeps overflow targets out of the comparison palette', () => {
    const plan = assignLatencyColors(['1', '4', '7', 'extra']);
    expect(plan.assignments).toHaveLength(3);
    expect(plan.overflowTaskIds).toEqual(['extra']);
  });

  it('recovers safely from a corrupted persisted color registry', () => {
    expect(parseLatencyColorRegistry('not a registry')).toEqual(new Map());
    const registry = new Map([['node-a', new Map([['1', '#3987e5']])]]);
    expect(parseLatencyColorRegistry(serializeLatencyColorRegistry(registry))).toEqual(registry);
  });

  it('starts a new path when a sample gap is too large', () => {
    const segments = buildLatencySegments([
      { timestamp: 0, value: 20 },
      { timestamp: 100, value: 30 },
      { timestamp: 301, value: 40 },
    ], 100);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.from.timestamp).toBe(0);
    expect(segments[0]?.to.timestamp).toBe(100);
  });

  it('builds continuous draw runs regardless of time-range sample density', () => {
    const dense = buildLatencyRuns([
      { timestamp: 0, value: 80 },
      { timestamp: 60_000, value: 81 },
      { timestamp: 120_000, value: 79 },
    ], 60_000);
    const sparse = buildLatencyRuns([
      { timestamp: 0, value: 80 },
      { timestamp: 3_600_000, value: 81 },
      { timestamp: 7_200_000, value: 79 },
    ], 3_600_000);
    expect(dense).toHaveLength(1);
    expect(dense[0]).toHaveLength(3);
    expect(sparse).toHaveLength(1);
    expect(sparse[0]).toHaveLength(3);
  });

  it('preserves gaps and unavailable samples as separate draw runs', () => {
    const runs = buildLatencyRuns([
      { timestamp: 0, value: 80 },
      { timestamp: 100, value: 81 },
      { timestamp: 200, value: null },
      { timestamp: 300, value: 82 },
      { timestamp: 400, value: 83 },
      { timestamp: 800, value: 84 },
      { timestamp: 900, value: 85 },
    ], 100);
    expect(runs.map((run) => run.map((point) => point.timestamp))).toEqual([
      [0, 100],
      [300, 400],
      [800, 900],
    ]);
  });

  it('formats the hovered timestamp and visible probe values', () => {
    const labels = new Map([['unicom', 'unicom'], ['mobile', 'mobile']]);
    expect(formatLatencyReadout(
      Date.parse('2026-10-11T01:02:03Z'),
      [
        { taskId: 'unicom', label: 'unicom', points: [{ timestamp: Date.parse('2026-10-11T01:02:00Z'), value: 42 }] },
        { taskId: 'mobile', label: 'mobile', points: [{ timestamp: Date.parse('2026-10-11T01:02:00Z'), value: 210 }] },
      ],
      labels,
      24,
    )).toContain('unicom 42.0ms');
  });
});

