import { describe, expect, it } from 'vitest';
import {
  LATENCY_RANGES,
  LATENCY_SERIES_COLORS,
  buildLatencySegments,
  formatLatencyReadout,
  latencyCeiling,
  latencySeriesColor,
  latencySeriesDash,
  toggleVisibleTasks,
} from '../src/latency';

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

  it('keeps target colors stable when the visible selection changes', () => {
    const allTaskIds = ['unicom', 'mobile', 'telecom'];
    expect(new Set(LATENCY_SERIES_COLORS.slice(0, allTaskIds.length)).size).toBe(allTaskIds.length);
    expect(latencySeriesColor('unicom', allTaskIds)).toBe(latencySeriesColor('unicom', ['unicom']));
    expect(latencySeriesColor('mobile', allTaskIds)).toBe(latencySeriesColor('mobile', ['unicom', 'mobile']));
    expect(latencySeriesDash('unicom', allTaskIds)).toBe(latencySeriesDash('unicom', ['unicom']));
    expect(latencySeriesDash('mobile', allTaskIds)).toBe(latencySeriesDash('mobile', ['unicom', 'mobile']));
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

