export type Route = { type: 'nodes' } | { type: 'detail'; uuid: string };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parsePath(pathname: string): Route | null {
  const normalized = pathname || '/';
  const match = normalized.match(/^\/nodes(?:\/([^/?#]+))?\/?$/);
  if (!match) {
    return normalized === '/' ? { type: 'nodes' } : null;
  }
  return match[1]
    ? { type: 'detail', uuid: decodeSegment(match[1]) }
    : { type: 'nodes' };
}

function parseHash(hash: string): Route | null {
  if (!hash.startsWith('#')) {
    return null;
  }
  return parsePath(hash.slice(1) || '/');
}

export function parseRoute(pathname: string, hash = ''): Route {
  const hashRoute = parseHash(hash);
  if ((pathname === '' || pathname === '/') && hashRoute) {
    return hashRoute;
  }
  return parsePath(pathname) ?? hashRoute ?? { type: 'nodes' };
}

export function routePath(route: Route): string {
  return route.type === 'nodes' ? '/' : `/nodes/${encodeURIComponent(route.uuid)}`;
}

export function legacyRoutePath(hash: string): string | null {
  if (!hash.startsWith('#')) {
    return null;
  }
  const route = parseHash(hash);
  return route ? routePath(route) : null;
}
