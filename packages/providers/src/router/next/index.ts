import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalizePattern,
  routeParams,
  type Diagnostic,
  type EnumerateInput,
  type EnumerateOutput,
  type NavRecognizers,
  type RouterProvider,
} from '@jsxray/core';
import { buildCandidateEdges, buildScreens, type ScreenDraft } from '../shared.js';

const PAGE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

export const nextRecognizers: NavRecognizers = {
  linkProps: [{ element: 'Link', prop: 'href' }],
  calls: [
    { callee: 'router.push', kind: 'push', target: { arg: 0 } },
    { callee: 'router.replace', kind: 'replace', target: { arg: 0 } },
    { callee: 'push', kind: 'push', target: { arg: 0 } },
    { callee: 'replace', kind: 'replace', target: { arg: 0 } },
    { callee: 'redirect', kind: 'redirect', target: { arg: 0 } },
    { callee: 'permanentRedirect', kind: 'redirect', target: { arg: 0 } },
  ],
};

export const nextRouter: RouterProvider = {
  axis: 'router',
  id: 'next',
  priority: 20,
  capabilities: { discovery: ['file'] },
  recognizers: nextRecognizers,

  supports: (profile) => profile.router === 'next-app' || profile.router === 'next-pages',

  async enumerate(input: EnumerateInput): Promise<EnumerateOutput> {
    const diagnostics: Diagnostic[] = [];
    const routerRoot = input.profile.routerRoot;
    if (!routerRoot) {
      return {
        screens: [],
        edges: [],
        strategy: 'file',
        diagnostics: [
          {
            level: 'warn',
            stage: 'enumerate',
            code: 'no-router-root',
            message: 'next router detected but no app/ or pages/ directory was found',
          },
        ],
      };
    }

    const base = path.join(input.root, routerRoot);
    const drafts =
      input.profile.router === 'next-app'
        ? 
          withoutDuplicates([
            ...walkAppRouter(base),
            ...walkPagesRouter(path.join(path.dirname(base), 'pages')),
          ])
        : walkPagesRouter(base);

    const screens = buildScreens(input.root, drafts, input.fileExports);
    const { edges, unattributed } = buildCandidateEdges(input.root, screens, input.navIntents);

    if (unattributed) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'unattributed-intents',
        message: `${unattributed} nav intents live in shared components and belong to no single screen`,
      });
    }

    return { screens, edges, strategy: 'file', diagnostics };
  },
};

/* ── app router (§13) ─────────────────────────────────────────────────────── */

interface AppContext {
  urlSegments: string[];
  groups: string[];
  layouts: string[];
  intercepted: boolean;
}

function walkAppRouter(base: string): ScreenDraft[] {
  const drafts: ScreenDraft[] = [];

  const visit = (dir: string, context: AppContext): void => {
    const entries = readDir(dir);
    const layouts = [...context.layouts];
    const layoutFile = entries.find((entry) => isSpecialFile(entry, 'layout'));
    if (layoutFile) layouts.push(path.join(dir, layoutFile));

    for (const entry of entries) {
      const absolute = path.join(dir, entry);
      if (isSpecialFile(entry, 'page')) {
        drafts.push(draftOf(context, absolute, 'page', true, layouts));
      } else if (isSpecialFile(entry, 'route')) {
        drafts.push(draftOf(context, absolute, 'route-handler', false, layouts));
      } else if (isSpecialFile(entry, 'not-found')) {
        drafts.push(draftOf(context, absolute, 'not-found', false, layouts));
      } else if (isSpecialFile(entry, 'error') || isSpecialFile(entry, 'global-error')) {
        drafts.push(draftOf(context, absolute, 'error', false, layouts));
      }
    }

    for (const entry of entries) {
      const absolute = path.join(dir, entry);
      if (!isDirectory(absolute)) continue;
      const next = descend(context, entry);
      if (next) visit(absolute, { ...next, layouts });
    }
  };

  visit(base, { urlSegments: [], groups: [], layouts: [], intercepted: false });
  return drafts;
}

function descend(context: AppContext, segment: string): AppContext | null {
  if (segment.startsWith('_')) return null; // opted out of routing entirely
  if (segment.startsWith('@')) return { ...context }; // parallel slot — not in the URL
  if (/^\(\.{1,2}\)|^\(\.\.\.\)/.test(segment)) {
    const cleaned = segment.replace(/^\((\.{1,3})\)/, '');
    return {
      ...context,
      urlSegments: [...context.urlSegments, cleaned],
      intercepted: true,
    };
  }
  if (/^\(.+\)$/.test(segment)) {
    return { ...context, groups: [...context.groups, segment.slice(1, -1)] };
  }
  return { ...context, urlSegments: [...context.urlSegments, segment] };
}

function draftOf(
  context: AppContext,
  absolute: string,
  kind: ScreenDraft['kind'],
  isPage: boolean,
  layouts: string[],
): ScreenDraft {
  const pattern = context.urlSegments.length ? `/${context.urlSegments.join('/')}` : '/';
  const route = canonicalizePattern(pattern);
  return {
    route,
    pattern,
    kind,
    isPage,
    absolute,
    suffix: context.intercepted ? 'intercepted' : isPage ? null : kind,
    meta: {
      groups: context.groups,
      dynamic: routeParams(route).length > 0,
      params: routeParams(route),
      ...(context.intercepted ? { intercepted: true } : {}),
    },
    layoutFiles: layouts,
  };
}

function isSpecialFile(entry: string, name: string): boolean {
  const extension = path.extname(entry);
  return PAGE_EXTENSIONS.includes(extension) && entry.slice(0, -extension.length) === name;
}

/* ── pages router ─────────────────────────────────────────────────────────── */

const PAGES_NON_SCREENS = new Set(['_app', '_document', '_error']);

function walkPagesRouter(base: string): ScreenDraft[] {
  const drafts: ScreenDraft[] = [];

  const visit = (dir: string, segments: string[]): void => {
    for (const entry of readDir(dir)) {
      const absolute = path.join(dir, entry);
      if (isDirectory(absolute)) {
        visit(absolute, [...segments, entry]);
        continue;
      }
      const extension = path.extname(entry);
      if (!PAGE_EXTENSIONS.includes(extension)) continue;
      const name = entry.slice(0, -extension.length);
      if (PAGES_NON_SCREENS.has(name)) continue;

      const urlSegments = name === 'index' ? segments : [...segments, name];
      const pattern = urlSegments.length ? `/${urlSegments.join('/')}` : '/';
      const route = canonicalizePattern(pattern);
      const isApi = segments[0] === 'api';

      drafts.push({
        route,
        pattern,
        kind: isApi ? 'route-handler' : 'page',
        isPage: !isApi,
        absolute,
        suffix: isApi ? 'route-handler' : null,
        meta: { groups: [], dynamic: routeParams(route).length > 0, params: routeParams(route) },
      });
    }
  };

  visit(base, []);
  return drafts;
}

/** App Router wins a collision — Next resolves it that way, and errors on it. */
function withoutDuplicates(drafts: readonly ScreenDraft[]): ScreenDraft[] {
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = `${draft.route}#${draft.suffix ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
