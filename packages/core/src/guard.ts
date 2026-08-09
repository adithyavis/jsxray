import type { IgnoreRules } from './config.js';
import { routeMatcher, type RouteMatcher } from './glob.js';
import type { Clickable, FormGroup } from './runtime.js';

/** §9. User rules extend the built-ins; they never replace them. */
export const BUILTIN_ROUTE_DENY: readonly string[] = [
  '**/logout',
  '**/log-out',
  '**/signout',
  '**/sign-out',
  '**/delete',
  '**/delete/**',
  '**/destroy',
  '**/remove/**',
  '**/pay',
  '**/payment/**',
  '**/checkout/confirm',
  '**/checkout/complete',
  '**/orders/confirm',
  '**/billing/cancel',
  '**/subscription/cancel',
  '**/account/close',
  '**/account/delete',
];

export const BUILTIN_UNSAFE_LABELS: readonly RegExp[] = [
  /\b(log|sign)\s?out\b/i,
  /\bdelete\b/i,
  /\bdestroy\b/i,
  /\bpermanently\b/i,
  /\bdeactivate\b/i,
  /\bclose (my )?account\b/i,
  /\bcancel (my )?(subscription|plan|membership)\b/i,
  /\bunsubscribe\b/i,
  /\b(pay|purchase|buy)\b/i,
  /\bplace order\b/i,
  /\bconfirm (order|payment|purchase)\b/i,
  /\b(transfer|withdraw)\b/i,
];

export interface SafetyGuard {
  blocksNavigation(route: string | null | undefined): boolean;
  blocksActions(route: string): boolean;
  blocksScreenshot(route: string): boolean;
  filterActions<T extends Clickable | FormGroup>(actions: readonly T[]): T[];
  reasonFor(action: Clickable | FormGroup): string | null;
}

export function createGuard(ignore: IgnoreRules = {}): SafetyGuard {
  const denyRoute: RouteMatcher = routeMatcher([
    ...BUILTIN_ROUTE_DENY,
    ...(ignore.navigation ?? []),
  ]);
  const noActions = routeMatcher(ignore.actions ?? []);
  const noScreenshots = routeMatcher(ignore.screenshots ?? []);

  const unsafeLabel = (label: string | null): boolean =>
    label != null && BUILTIN_UNSAFE_LABELS.some((re) => re.test(label));

  const reasonFor = (action: Clickable | FormGroup): string | null => {
    if (unsafeLabel(action.label)) return `unsafe label: ${JSON.stringify(action.label)}`;
    const target = 'target' in action ? action.target : null;
    if (target && denyRoute(hrefToPath(target))) return `denied route: ${target}`;
    if ('submit' in action && action.submit && unsafeLabel(action.submit.label)) {
      return `unsafe submit label: ${JSON.stringify(action.submit.label)}`;
    }
    return null;
  };

  return {
    blocksNavigation: (route) => (route == null ? false : denyRoute(hrefToPath(route))),
    blocksActions: (route) => noActions(route),
    blocksScreenshot: (route) => noScreenshots(route),
    filterActions: (actions) => actions.filter((action) => reasonFor(action) === null),
    reasonFor,
  };
}

function hrefToPath(target: string): string {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return new URL(target).pathname;
  } catch {
    /* an unparseable href is matched as written */
  }
  return target;
}
