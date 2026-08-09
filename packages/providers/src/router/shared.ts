import path from 'node:path';
import {
  canonicalizeUrl,
  matchRoute,
  screenId,
  type Edge,
  type FileExports,
  type NavIntent,
  type Screen,
  type ScreenKind,
  type ScreenMeta,
} from '@jsxray/core';
import { toRepoPath } from '../module-resolution.js';

export interface ScreenDraft {
  route: string;
  pattern: string;
  kind: ScreenKind;
  isPage: boolean;
  absolute: string | null;
  suffix?: string | null;
  meta?: Partial<ScreenMeta>;
  layoutFiles?: string[];
}

export function buildScreens(
  root: string,
  drafts: readonly ScreenDraft[],
  fileExports: readonly FileExports[],
): Screen[] {
  const defaultByFile = new Map(
    fileExports.map((entry) => [entry.file, entry.defaultComponentId]),
  );
  const routeCounts = new Map<string, number>();
  for (const draft of drafts) routeCounts.set(draft.route, (routeCounts.get(draft.route) ?? 0) + 1);

  return drafts.map((draft) => {
    const file = draft.absolute ? toRepoPath(root, draft.absolute) : null;
    const shared = (routeCounts.get(draft.route) ?? 0) > 1;
    const suffix = draft.suffix ?? (shared && !draft.isPage ? draft.kind : null);
    return {
      id: screenId(draft.route, suffix),
      route: draft.route,
      pattern: draft.pattern,
      kind: draft.kind,
      isPage: draft.isPage,
      file,
      componentId: file ? (defaultByFile.get(file) ?? null) : null,
      layoutComponentIds: (draft.layoutFiles ?? [])
        .map((layout) => defaultByFile.get(toRepoPath(root, layout)) ?? null)
        .filter((id): id is string => id !== null),
      meta: {
        groups: draft.meta?.groups ?? [],
        dynamic: draft.meta?.dynamic ?? /[:*]/.test(draft.route),
        params: draft.meta?.params ?? [],
        ...(draft.meta?.intercepted ? { intercepted: true } : {}),
      },
      tree: null,
      layoutTrees: null,
    };
  });
}

/**
 * §5 — candidate transitions. An intent is attributed to the screen whose
 * component owns it, or to the screen it is co-located with; a nav bar shared
 * by every screen is left unattributed rather than fanned out across all of them.
 */
export function buildCandidateEdges(
  root: string,
  screens: readonly Screen[],
  intents: readonly NavIntent[],
): { edges: Edge[]; unattributed: number } {
  const pages = screens.filter((screen) => screen.isPage);
  const patterns = pages.map((screen) => screen.route);
  const byComponentId = new Map(
    pages.filter((screen) => screen.componentId).map((screen) => [screen.componentId!, screen]),
  );
  const byDirectory = new Map<string, Screen>();
  for (const screen of pages) {
    if (screen.file) byDirectory.set(path.posix.dirname(screen.file), screen);
  }

  const edges: Edge[] = [];
  let unattributed = 0;

  for (const intent of intents) {
    const owner =
      (intent.componentId ? byComponentId.get(intent.componentId) : undefined) ??
      nearestByDirectory(intent.loc.file, byDirectory);
    if (!owner) {
      unattributed++;
      continue;
    }

    const target = intent.target ? resolveTarget(intent.target, patterns) : null;
    const to = target ? (pages.find((screen) => screen.route === target)?.id ?? null) : null;
    const id = `static:${owner.id}->${to ?? '?'}:${intent.loc.file}:${intent.loc.line}`;
    if (edges.some((edge) => edge.id === id)) continue;

    edges.push({
      id,
      discoveredBy: 'static',
      kind: intent.kind,
      from: owner.id,
      to,
      label: intent.trigger,
      componentId: intent.componentId,
      loc: intent.loc,
      targetExpression: intent.targetExpression,
      matchKey: null,
    });
  }

  return { edges, unattributed };
}

/** A co-located component belongs to the nearest screen above it. */
function nearestByDirectory(file: string, byDirectory: Map<string, Screen>): Screen | undefined {
  let dir = path.posix.dirname(file);
  while (dir && dir !== '.' && dir !== '/') {
    const found = byDirectory.get(dir);
    if (found) return found;
    dir = path.posix.dirname(dir);
  }
  return byDirectory.get('.');
}

function resolveTarget(target: string, patterns: readonly string[]): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('/')) return null;
  const matched = matchRoute(target, patterns);
  return matched ? matched.route : canonicalizeUrl(target, patterns);
}

/** Remix / TanStack flat-file convention: `posts.$id.tsx` → `/posts/:id`. */
export function flatFileRoute(relative: string): { route: string; pathless: boolean } | null {
  const withoutExtension = relative.replace(/\.[^./]+$/, '');
  const parts = withoutExtension.split('/');
  const last = parts.pop()!;
  const tokens = [...parts, ...last.split('.')];

  const segments: string[] = [];
  let pathless = false;

  for (const raw of tokens) {
    if (!raw.length) continue;
    if (raw === 'route' || raw === '_index' || raw === 'index') continue;
    if (raw === '__root' || raw.startsWith('__')) return null;
    if (raw.startsWith('_')) {
      pathless = true;
      continue;
    }
    const token = raw.endsWith('_') ? raw.slice(0, -1) : raw;
    if (token === '$') {
      segments.push('*splat');
      continue;
    }
    if (token.startsWith('$')) {
      segments.push(`:${token.slice(1)}`);
      continue;
    }
    segments.push(token.replace(/^\[(.+)\]$/, '$1'));
  }

  return { route: segments.length ? `/${segments.join('/')}` : '/', pathless };
}
