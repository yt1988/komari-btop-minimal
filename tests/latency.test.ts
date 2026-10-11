import { describe, expect, it } from 'vitest';
import {
  LATENCY_RANGES,
  buildLatencySegments,
  latencyCeiling,
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

  it('splits segments at latency thresholds and assigns each tone', () => {
    const segments = buildLatencySegments([
      { timestamp: 0, value: 50 },
      { timestamp: 10, value: 250 },
    ], 100);
    expect(segments.map((segment) => [segment.from.timestamp, segment.to.timestamp, segment.tone])).toEqual([
      [0, 2.5, 'normal'],
      [2.5, 7.5, 'warning'],
      [7.5, 10, 'danger'],
    ]);
    expect(latencyCeiling([{ timestamp: 0, value: 201 }])).toBe(300);
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
});

