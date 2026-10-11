import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatPercent,
  formatSpeed,
  metricTone,
  networkTone,
  progressBar,
} from '../src/format';

describe('terminal formatting', () => {
  it('formats binary byte values and compact speed units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MiB');
    expect(formatSpeed(1024)).toBe('1.0 KB/s');
    expect(formatSpeed(1024 ** 2)).toBe('1.0 MB/s');
    expect(formatSpeed(1024 ** 3)).toBe('1.0 GB/s');
    expect(formatBytes(null)).toBe('--');
    expect(formatSpeed(Number.NaN)).toBe('--');
  });

  it('keeps percentages and bars bounded', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(70.4)).toBe('70%');
    expect(formatPercent(110)).toBe('100%');
    expect(progressBar(0, 5)).toBe('░░░░░');
    expect(progressBar(1, 5)).toBe('█░░░░');
    expect(progressBar(27, 100, 10)).toBe('███░░░░░░░');
    expect(progressBar(1.1, 1, 5)).toBe('█████');
  });

  it('uses green through the warning boundary and yellow above it', () => {
    expect(metricTone(70)).toBe('normal');
    expect(metricTone(70.01)).toBe('warning');
    expect(networkTone(1024 ** 2)).toBe('normal');
    expect(networkTone(1024 ** 2 + 1)).toBe('warning');
  });
});

