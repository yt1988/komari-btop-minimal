import { describe, expect, it } from 'vitest';
import {
  legacyRoutePath,
  parseRoute,
  routePath,
} from '../src/router';

describe('clean browser routes', () => {
  it('reads the node list and detail routes from the pathname', () => {
    expect(parseRoute('/', '')).toEqual({ type: 'nodes' });
    expect(parseRoute('/nodes/', '')).toEqual({ type: 'nodes' });
    expect(parseRoute('/nodes/node%2F1', '')).toEqual({ type: 'detail', uuid: 'node/1' });
  });

  it('understands legacy hash routes while they are being migrated', () => {
    expect(parseRoute('/', '#/nodes/node-1')).toEqual({ type: 'detail', uuid: 'node-1' });
    expect(legacyRoutePath('#/nodes/node-1')).toBe('/nodes/node-1');
    expect(legacyRoutePath('#')).toBe('/');
  });

  it('writes routes without a hash fragment', () => {
    expect(routePath({ type: 'nodes' })).toBe('/');
    expect(routePath({ type: 'detail', uuid: 'node/1' })).toBe('/nodes/node%2F1');
  });
});
