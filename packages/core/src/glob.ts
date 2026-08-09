import picomatch from 'picomatch';

/** §9 — every ignore list is globs over the canonical route. */
export type RouteMatcher = (route: string) => boolean;

export function routeMatcher(patterns: readonly string[]): RouteMatcher {
  if (!patterns.length) return () => false;
  const isMatch = picomatch(patterns.map(normalizePattern), { dot: true, nocase: true });
  return (route: string) => isMatch(normalizeRoute(route));
}

function normalizeRoute(route: string): string {
  const base = route.split('$')[0] ?? route;
  return base.startsWith('/') ? base : `/${base}`;
}

function normalizePattern(pattern: string): string {
  return pattern.startsWith('/') || pattern.startsWith('*') ? pattern : `/${pattern}`;
}
