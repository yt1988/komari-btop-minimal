import { describe, expect, it } from 'vitest';
import { parseLoadRecordTimes } from '../src/api/komari';
import { formatDayClock, formatDuration } from '../src/format';
import { buildOutages } from '../src/statusHistory';

const at = (time: string, day = 22): number => Date.parse(`2026-10-${day}T${time}:00Z`);

function every(minutes: number, from: number, to: number): number[] {
  const times: number[] = [];
  for (let time = from; time <= to; time += minutes * 60_000) {
    times.push(time);
  }
  return times;
}

const now = at('08:25');
const old = Date.parse('2026-01-01T00:00:00Z');

describe('outage history', () => {
  it('uses per-minute records for the last 6h', () => {
    // Bero.6 on 2026-10-22: created at 06:23, three outages.
    const fine = [
      ...every(1, at('06:25'), at('06:29')),
      ...every(1, at('06:55'), at('07:19')),
      ...every(1, at('07:40'), at('07:56')),
      ...every(1, at('08:19'), now),
    ];
    const input = { fineTimes: fine, coarseTimes: every(5, at('06:25'), now), now, online: true, lastReportAt: now, createdAt: at('06:23') };
    const outages = buildOutages(input);
    expect(outages.map((outage) => [outage.start, outage.end])).toEqual([
      [at('06:29'), at('06:55')],
      [at('07:19'), at('07:40')],
      [at('07:56'), at('08:19')],
    ]);
  });

  it('uses five-minute records before that and ignores skipped downsampling buckets', () => {
    const coarse = every(5, at('08:30', 21), now)
      .filter((time) => time <= at('23:00', 21) || time >= at('23:30', 21))
      .filter((time) => time !== at('01:05') && time !== at('01:10'));
    const input = { fineTimes: every(1, at('02:25'), now), coarseTimes: coarse, now, online: true, lastReportAt: now, createdAt: old };
    const outages = buildOutages(input);
    expect(outages).toEqual([{ start: at('23:00', 21), end: at('23:30', 21), ongoing: false, startClipped: false }]);
  });

  it('reports a node up for the whole window as at least 24h', () => {
    const input = { fineTimes: every(1, at('02:25'), now), coarseTimes: every(5, at('08:30', 21), now), now, online: true, lastReportAt: now, createdAt: old };
    const outages = buildOutages(input);
    expect(outages).toEqual([]);
  });

  it('keeps an outage that began before the window', () => {
    const coarse = every(5, at('10:00', 21), now);
    const input = { fineTimes: every(1, at('02:25'), now), coarseTimes: coarse, now, online: true, lastReportAt: now, createdAt: old };
    expect(buildOutages(input)).toEqual([{ start: at('08:25', 21), end: at('10:00', 21), ongoing: false, startClipped: true }]);
  });

  it('dates an outage longer than the window from the last report', () => {
    const input = { fineTimes: [], coarseTimes: [], now, online: false, lastReportAt: at('12:00', 19), createdAt: old };
    const outages = buildOutages(input);
    expect(outages).toEqual([{ start: at('12:00', 19), end: now, ongoing: true, startClipped: false }]);
  });

  it('parses load record timestamps in order', () => {
    expect(parseLoadRecordTimes({
      status: 'success',
      data: { records: [{ time: '2026-10-22T06:26:00Z' }, { time: '2026-10-22T06:25:00Z' }, { time: 'bad' }] },
    })).toEqual([at('06:25'), at('06:26')]);
  });

  it('marks times from the previous day with a leading dash', () => {
    const local = (day: number, hour: number, minute: number): number => new Date(2026, 9, day, hour, minute).getTime();
    expect(formatDayClock(local(22, 16, 19), local(22, 16, 40))).toBe('16:19');
    expect(formatDayClock(local(21, 23, 50), local(22, 0, 10))).toBe('-23:50');
  });

  it('formats compact durations', () => {
    expect([formatDuration(20_000), formatDuration(47 * 60_000), formatDuration(65 * 60_000), formatDuration(120 * 60_000), formatDuration(51 * 3_600_000)])
      .toEqual(['1m', '47m', '1h5m', '2h', '2d3h']);
  });
});
