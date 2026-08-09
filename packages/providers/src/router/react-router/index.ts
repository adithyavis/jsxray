import path from 'node:path';
import {
  routeParams,
  walkFiles,
  type EnumerateInput,
  type EnumerateOutput,
  type NavRecognizers,
  type RouterProvider,
} from '@jsxray/core';
import { buildCandidateEdges, buildScreens, flatFileRoute, type ScreenDraft } from '../shared.js';

const ROUTE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

export const reactRouterRecognizers: NavRecognizers = {
  linkProps: [
    { element: 'Link', prop: 'to' },
    { element: 'NavLink', prop: 'to' },
  ],
  calls: [
    { callee: 'navigate', kind: 'push', target: { arg: 0 } },
    { callee: 'redirect', kind: 'redirect', target: { arg: 0 } },
  ],
};

export const reactRouterRouter: RouterProvider = {
  axis: 'router',
  id: 'react-router',
  priority: 15,
  capabilities: { discovery: ['file'] },
  recognizers: reactRouterRecognizers,

  supports: (profile) => profile.router === 'react-router',

  async enumerate(input: EnumerateInput): Promise<EnumerateOutput> {
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
            message: 'react-router detected but no routes directory was found',
          },
        ],
      };
    }

    const base = path.join(input.root, routerRoot);
    const drafts: ScreenDraft[] = [];

    for (const absolute of walkFiles(base, { extensions: ROUTE_EXTENSIONS })) {
      const relative = path.relative(base, absolute).split(path.sep).join('/');
      if (/(^|\/)_/.test(relative) && !/(^|\/)_index\./.test(relative)) {
        if (!/(^|\/)_[^/]*\.[^./]+$/.test(relative)) continue;
      }
      const parsed = flatFileRoute(relative);
      if (!parsed || parsed.pathless) continue;

      drafts.push({
        route: parsed.route,
        pattern: parsed.route,
        kind: 'page',
        isPage: true,
        absolute,
        meta: {
          groups: [],
          dynamic: routeParams(parsed.route).length > 0,
          params: routeParams(parsed.route),
        },
      });
    }

    const screens = buildScreens(input.root, dedupeByRoute(drafts), input.fileExports);
    const { edges } = buildCandidateEdges(input.root, screens, input.navIntents);
    return { screens, edges, strategy: 'file', diagnostics: [] };
  },
};

function dedupeByRoute(drafts: readonly ScreenDraft[]): ScreenDraft[] {
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    if (seen.has(draft.route)) return false;
    seen.add(draft.route);
    return true;
  });
}
