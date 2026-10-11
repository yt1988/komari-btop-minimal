import { describe, expect, it } from 'vitest';
import {
  calculateTrafficUsage,
  getTrafficPresentation,
  trafficTone,
} from '../src/traffic';

const traffic = { up: 10, down: 40 };

describe('traffic rules', () => {
  it('matches Komari traffic accounting modes', () => {
    expect(calculateTrafficUsage(traffic, 'sum')).toBe(50);
    expect(calculateTrafficUsage(traffic, 'max')).toBe(40);
    expect(calculateTrafficUsage(traffic, 'min')).toBe(10);
    expect(calculateTrafficUsage(traffic, 'up')).toBe(10);
    expect(calculateTrafficUsage(traffic, 'down')).toBe(40);
    expect(calculateTrafficUsage(traffic, 'unexpected')).toBe(40);
  });

  it('distinguishes unlimited and limited nodes', () => {
    expect(getTrafficPresentation(traffic, null, null).limited).toBe(false);
    expect(getTrafficPresentation(traffic, 100, 'sum')).toMatchObject({
      limited: true,
      used: 50,
      ratio: 0.5,
    });
    expect(getTrafficPresentation(traffic, 0, 'sum').ratio).toBe(0);
  });

  it('caps progress and warns only above eighty percent', () => {
    expect(getTrafficPresentation({ up: 80, down: 1 }, 100, 'sum').ratio).toBe(0.81);
    expect(trafficTone(0.8)).toBe('normal');
    expect(trafficTone(0.80001)).toBe('warning');
    expect(getTrafficPresentation({ up: 200, down: 0 }, 100, 'sum').ratio).toBe(1);
  });
});

