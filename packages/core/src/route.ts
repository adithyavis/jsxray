import { slugify } from './paths.js';

/** §3 — `#` disambiguates screens sharing a route, `$` names states over a screen. */
export const SCREEN_SUFFIX = '#';
export const STATE_SUFFIX = '$';

export function splitRoute(route: string): string[] {
  return route.split('/').filter((segment) => segment.length > 0);
}

export function joinRoute(segments: readonly string[]): string {
  return segments.length ? `/${segments.join('/')}` : '/';
}

export function canonicalizePattern(pattern: string): string {
  return joinRoute(
    splitRoute(pattern).map((segment) => {
      const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
      if (optionalCatchAll) return `*${optionalCatchAll[1]}?`;
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
      if (catchAll) return `*${catchAll[1]}`;
      const dynamic = /^\[(.+)\]$/.exec(segment);
      if (dynamic) return `:${dynamic[1]}`;
      return segment;
    }),
  );
}

export function routeParams(route: string): string[] {
  return splitRoute(route)
    .filter((segment) => segment.startsWith(':') || segment.startsWith('*'))
    .map((segment) => segment.replace(/^[:*]/, '').replace(/\?$/, ''));
}

export function isDynamic(route: string): boolean {
  return routeParams(route).length > 0;
}

export interface RouteMatch {
  route: string;
  params: Record<string, string>;
}

/** Literal segments beat dynamic ones, longer patterns beat shorter (§3). */
export function matchRoute(pathname: string, patterns: readonly string[]): RouteMatch | null {
  const observed = splitRoute(stripUrl(pathname));
  let best: { match: RouteMatch; score: number } | null = null;
  for (const pattern of patterns) {
    const scored = matchOne(observed, pattern);
    if (scored && (!best || scored.score > best.score)) best = scored;
  }
  return best?.match ?? null;
}

function matchOne(observed: string[], pattern: string): { match: RouteMatch; score: number } | null {
  const segments = splitRoute(pattern);
  const params: Record<string, string> = {};
  let score = 0;
  let index = 0;

  for (const segment of segments) {
    if (segment.startsWith('*')) {
      const name = segment.replace(/^\*/, '').replace(/\?$/, '') || 'splat';
      const rest = observed.slice(index);
      if (!rest.length && !segment.endsWith('?')) return null;
      params[name] = rest.join('/');
      index = observed.length;
      score += 1;
      continue;
    }

    const value = observed[index];
    if (value === undefined) return null;

    if (segment.startsWith(':')) {
      params[segment.slice(1)] = value;
      score += 2;
    } else if (segment === value) {
      score += 3;
    } else {
      return null;
    }
    index++;
  }

  if (index !== observed.length) return null;
  return { match: { route: canonicalizePattern(pattern), params }, score: score + segments.length };
}

const ID_SHAPES: readonly RegExp[] = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{24}$/i,
  /^[A-Za-z0-9_-]{12,}$/,
];

export function looksLikeId(segment: string): boolean {
  if (!segment) return false;
  if (/^[a-z]+(-[a-z]+)*$/.test(segment) && segment.length < 24) return false;
  return ID_SHAPES.some((shape) => shape.test(segment));
}

export function canonicalizeUrl(url: string, patterns: readonly string[] = []): string {
  const pathname = stripUrl(url);
  const matched = matchRoute(pathname, patterns);
  if (matched) return matched.route;
  return joinRoute(splitRoute(pathname).map((segment) => (looksLikeId(segment) ? ':id' : segment)));
}

export function stripUrl(url: string): string {
  let value = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (scheme) {
    const withoutScheme = value.slice(scheme[0].length);
    const slash = withoutScheme.indexOf('/');
    value = slash === -1 ? '/' : withoutScheme.slice(slash);
  }
  value = value.split('#')[0]!.split('?')[0]!;
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value.length ? value : '/';
}

export function screenId(route: string, suffix?: string | null): string {
  return suffix ? `${route}${SCREEN_SUFFIX}${suffix}` : route;
}

export function routeOfScreenId(id: string): string {
  return id.split(SCREEN_SUFFIX)[0]!;
}

/** §3.1 — screen id plus one `$` segment per overlay, outermost first. */
export function stateSignature(screen: string, overlayNames: readonly string[] = []): string {
  if (!overlayNames.length) return screen;
  return `${screen}${STATE_SUFFIX}${overlayNames.map(slugify).join(STATE_SUFFIX)}`;
}

export function screenOfStateSignature(signature: string): string {
  return signature.split(STATE_SUFFIX)[0]!;
}

export function overlaysOfStateSignature(signature: string): string[] {
  return signature.split(STATE_SUFFIX).slice(1);
}

/** §5.1. */
export function edgeMatchKey(from: string, to: string | null | undefined): string | null {
  if (!to) return null;
  return `${screenOfStateSignature(from)} ${screenOfStateSignature(to)}`;
}
