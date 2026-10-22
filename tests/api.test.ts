import { describe, expect, it } from 'vitest';
import {
  parseLatencyQuery,
  parseLiveSnapshot,
  parseNodeMetadata,
  parsePingTasks,
  parsePublicSettings,
  unwrapStandardResponse,
} from '../src/api/komari';

describe('Komari response normalization', () => {
  it('normalizes node metadata from the standard envelope', () => {
    const response = {
      status: 'success',
      data: [{
        uuid: 'node-1',
        name: 'edge-a',
        group: 'prod',
        region: '🇩🇪',
        weight: 4,
        mem_total: 1024,
        disk_total: 2048,
        traffic_limit: 4096,
        traffic_limit_type: 'sum',
        ignored: true,
      }],
    };
    expect(parseNodeMetadata(response)).toEqual([{
      uuid: 'node-1',
      name: 'edge-a',
      group: 'prod',
      region: '🇩🇪',
      weight: 4,
      memTotal: 1024,
      diskTotal: 2048,
      trafficLimit: 4096,
      trafficLimitType: 'sum',
    }]);
  });

  it('keeps the backend node order defined by weight', () => {
    expect(parseNodeMetadata({
      status: 'success',
      data: [
        { uuid: 'late', name: 'late', weight: 9 },
        { uuid: 'first', name: 'first', weight: 1 },
        { uuid: 'middle', name: 'middle', weight: 4 },
        { uuid: 'tie', name: 'tie', weight: 4 },
      ],
    }).map((node) => node.uuid)).toEqual(['first', 'middle', 'tie', 'late']);
  });

  it('normalizes task ids and live report data', () => {
    expect(parsePingTasks({
      status: 'success',
      data: [{ id: 7, name: 'unicom', clients: ['node-1'], default_on: true, type: 'icmp', interval: 60 }],
    })).toEqual([{
      id: '7',
      name: 'unicom',
      clients: ['node-1'],
      defaultOn: true,
      type: 'icmp',
      interval: 60,
    }]);

    expect(parseLiveSnapshot({
      status: 'success',
      data: {
        online: ['node-1'],
        data: {
          'node-1': {
            cpu: { usage: 12.5 },
            ram: { total: 100, used: 25 },
            disk: { total: 200, used: 50 },
            network: { up: 10, down: 20, totalUp: 1000, totalDown: 2000 },
            updated_at: '2026-10-11T01:02:03Z',
          },
        },
      },
    })).toEqual({
      online: ['node-1'],
      data: {
        'node-1': {
          cpuUsage: 12.5,
          ram: { total: 100, used: 25 },
          disk: { total: 200, used: 50 },
          network: { up: 10, down: 20, totalUp: 1000, totalDown: 2000 },
          uptimeSeconds: null,
          updatedAt: Date.parse('2026-10-11T01:02:03Z'),
        },
      },
    });
  });

  it('preserves unavailable live fields instead of fabricating zero values', () => {
    expect(parseLiveSnapshot({
      status: 'success',
      data: {
        online: ['node-1'],
        data: {
          'node-1': {
            ram: { used: 100 },
            network: { up: 42 },
          },
        },
      },
    }).data['node-1']).toMatchObject({
      ram: { used: 100, total: null },
      network: { up: 42, down: null, totalUp: null, totalDown: null },
    });
  });

  it('reads the public site name with a safe terminal fallback', () => {
    expect(parsePublicSettings({
      status: 'success',
      data: { sitename: 'Taos' },
    })).toEqual({ siteName: 'Taos' });
    expect(parsePublicSettings({
      status: 'success',
      data: { sitename: '   ' },
    })).toEqual({ siteName: 'Komari' });
  });

  it('normalizes latency series tags and timestamps', () => {
    expect(parseLatencyQuery({
      status: 'success',
      data: {
        start: '2026-10-10T00:00:00Z',
        end: '2026-10-11T00:00:00Z',
        series: [{
          metric_key: 'ping.latency_ms',
          tags: { task_id: '7' },
          interval_seconds: 60,
          points: [
            { time: '2026-10-10T01:00:00Z', value: 42 },
            { time: '2026-10-10T02:00:00Z', value: null },
          ],
        }],
      },
    })).toEqual({
      start: Date.parse('2026-10-10T00:00:00Z'),
      end: Date.parse('2026-10-11T00:00:00Z'),
      intervalSeconds: 60,
      series: [{
        taskId: '7',
        label: '7',
        points: [
          { timestamp: Date.parse('2026-10-10T01:00:00Z'), value: 42 },
          { timestamp: Date.parse('2026-10-10T02:00:00Z'), value: null },
        ],
      }],
    });
  });

  it('rejects failed envelopes and malformed required data', () => {
    expect(() => unwrapStandardResponse({ status: 'error', message: 'nope' }, '/api/nodes')).toThrow('/api/nodes');
    expect(() => parseNodeMetadata({ status: 'success', data: [{ name: 'missing uuid' }] })).toThrow('/api/nodes');
    expect(() => parseLatencyQuery({ status: 'success', data: { series: [{ points: {} }] } })).toThrow('/api/rpc2');
  });
});

