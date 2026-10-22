import { describe, expect, it } from 'vitest';
import type { LatencyQuery } from '../src/domain';
import { formatLoss, lossTone } from '../src/format';
import { correctLostProbes, latencyStats, mergeLatencyQuality } from '../src/latency';

describe('latency quality', () => {
  it('removes lost probes recorded as -1ms from the bucket mean and spread', () => {
    // ALI.HK → BJ.CU.6, 5-minute bucket: 15 probes, 8 lost.
    const corrected = correctLostProbes(65.8, 71.7, 15, 8 / 15);
    expect(corrected.value).toBeCloseTo(142.14, 2);
    expect(corrected.spread).toBeCloseTo(9.39, 2);
  });

  it('keeps clean buckets as they are and drops fully lost ones', () => {
    expect(correctLostProbes(48.1, 2.3, 15, 0)).toEqual({ value: 48.1, spread: 2.3 });
    expect(correctLostProbes(-1, 0, 15, 1)).toEqual({ value: null, spread: null });
    expect(correctLostProbes(48.1, null, null, null)).toEqual({ value: 48.1, spread: null });
  });

  it('merges mean, stddev and loss queries per target and timestamp', () => {
    const query = (values: number[], counts = true): LatencyQuery => ({
      start: 0,
      end: 600_000,
      intervalSeconds: 300,
      series: [{ taskId: '2', label: '2', points: values.map((value, index) => ({ timestamp: index * 300_000, value, ...(counts ? { samples: 15 } : {}) })) }],
    });
    const merged = mergeLatencyQuality(query([65.8, 140]), query([71.7, 9], false), query([8 / 15, 0], false));
    expect(merged.series[0]?.points.map((point) => [Math.round(point.value!), Math.round(point.spread!), point.loss])).toEqual([
      [142, 9, 8 / 15],
      [140, 9, 0],
    ]);
    expect(mergeLatencyQuality(query([50]), null, null).series[0]?.points[0]).toEqual({ timestamp: 0, value: 50, spread: null, loss: null, samples: 15 });
  });

  it('summarises a range weighted by replied and total probes', () => {
    const stats = latencyStats([
      { timestamp: 0, value: 50, spread: 2, loss: 0, samples: 15 },
      { timestamp: 1, value: 150, spread: 10, loss: 2 / 3, samples: 15 },
      { timestamp: 2, value: null, spread: null, loss: 1, samples: 15 },
    ]);
    expect(stats.mean).toBeCloseTo((50 * 15 + 150 * 5) / 20, 6);
    expect(stats.jitter).toBeCloseTo((2 * 15 + 10 * 5) / 20, 6);
    expect(stats.loss).toBeCloseTo(25 / 45, 6);
  });

  it('formats loss tersely with a tone', () => {
    expect([formatLoss(0.003), formatLoss(0.425), formatLoss(0)]).toEqual(['0.3%', '43%', '0.0%']);
    expect([lossTone(0.003), lossTone(0.02), lossTone(0.425)]).toEqual(['muted', 'warn', 'danger']);
  });
});
