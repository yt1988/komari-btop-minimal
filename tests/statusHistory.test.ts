import { describe, expect, it } from 'vitest';
import { parseLoadRecordTimes } from '../src/api/komari';
import { formatDuration } from '../src/format';
import { buildStatusHistory, currentStateSince } from '../src/statusHistory';

const at = (time: string): number => Date.parse(`2026-10-22T${time}:00Z`);

function minutes(from: string, to: string): number[] {
  const times: number[] = [];
  for (let time = at(from); time <= at(to); time += 60_000) {
    times.push(time);
  }
  return times;
}

// Bero.6 on 2026-10-22: added at 06:25, two outages, rebooted at 07:37.
const bero = [...minutes('06:25', '06:29'), ...minutes('06:55', '07:19'), ...minutes('07:40', '07:57')];

describe('status history', () => {
  it('infers outages and the latest reboot from record gaps', () => {
    const history = buildStatusHistory({
      recordTimes: bero,
      now: at('07:58'),
      online: true,
      lastReportAt: at('07:58'),
      uptimeSeconds: 21 * 60,
    });
    expect(history.intervals).toEqual([
      { start: at('06:29'), end: at('06:55'), ongoing: false },
      { start: at('07:19'), end: at('07:40'), ongoing: false },
    ]);
    expect(history.boot).toBe(at('07:37'));
  });

  it('reports an ongoing outage while offline', () => {
    const history = buildStatusHistory({
      recordTimes: minutes('01:00', '07:19'),
      now: at('07:53'),
      online: false,
      lastReportAt: at('07:19'),
      uptimeSeconds: 900,
    });
    expect(history.intervals).toEqual([{ start: at('07:19'), end: at('07:53'), ongoing: true }]);
    expect(history.boot).toBe(at('07:04'));
    expect(currentStateSince(history, false, at('07:19'), 900, at('07:53'))).toBe(at('07:19'));
  });

  it('ignores missing single minutes and records older than the window', () => {
    const times = minutes('01:00', '07:00').filter((time) => time !== at('04:00') && time !== at('04:01'));
    const history = buildStatusHistory({ recordTimes: times, now: at('07:00'), online: true, lastReportAt: at('07:00'), uptimeSeconds: 86_400 });
    expect(history).toEqual({ intervals: [], boot: null });
  });

  it('parses load record timestamps in order', () => {
    expect(parseLoadRecordTimes({
      status: 'success',
      data: { records: [{ time: '2026-10-22T06:26:00Z' }, { time: '2026-10-22T06:25:00Z' }, { time: 'bad' }] },
    })).toEqual([at('06:25'), at('06:26')]);
  });

  it('formats compact durations', () => {
    expect([formatDuration(20_000), formatDuration(47 * 60_000), formatDuration(65 * 60_000), formatDuration(120 * 60_000), formatDuration(51 * 3_600_000)])
      .toEqual(['1m', '47m', '1h5m', '2h', '2d3h']);
  });
});
