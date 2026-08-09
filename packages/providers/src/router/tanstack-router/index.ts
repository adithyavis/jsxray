import fs from 'node:fs';
import path from 'node:path';
import {
  isDirectory,
  routeParams,
  walkFiles,
  type Diagnostic,
  type DiscoveryStrategy,
  type EnumerateInput,
  type EnumerateOutput,
  type NavRecognizers,
  type RouterProvider,
} from '@jsxray/core';
import { buildCandidateEdges, buildScreens, flatFileRoute, type ScreenDraft } from '../shared.js';

const ROUTE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];
const FILE_ROUTE_CALL = /createFileRoute\(\s*['"]([^'"]+)['"]/g;

export const tanstackRecognizers: NavRecognizers = {
  linkProps: [{ element: 'Link', prop: 'to' }],
  calls: [
    { callee: 'navigate', kind: 'push', target: { arg: 0, key: 'to' } },
    { callee: 'router.navigate', kind: 'push', target: { arg: 0, key: 'to' } },
    { callee: 'redirect', kind: 'redirect', target: { arg: 0, key: 'to' } },
  ],
};

export const tanstackRouter: RouterProvider = {
  axis: 'router',
  id: 'tanstack-router',
  priority: 18,
  capabilities: { discovery: ['generated', 'file'] },
  recognizers: tanstackRecognizers,

  supports: (profile) => profile.router === 'tanstack-router',

  async enumerate(input: EnumerateInput): Promise<EnumerateOutput> {
    const diagnostics: Diagnostic[] = [];
    const routerRoot = input.profile.routerRoot;

    // §4 — a generated route tree is authoritative and needs no convention-guessing.
    const generated = routerRoot?.endsWith('routeTree.gen.ts')
      ? path.join(input.root, routerRoot)
      : null;

    let drafts: ScreenDraft[] = [];
    let strategy: DiscoveryStrategy = 'file';

    if (generated && fs.existsSync(generated)) {
      drafts = fromGeneratedTree(generated);
      strategy = 'generated';
    }

    if (!drafts.length) {
      const routesDir = resolveRoutesDir(input.root, routerRoot);
      if (!routesDir) {
        return {
          screens: [],
          edges: [],
          strategy,
          diagnostics: [
            {
              level: 'warn',
              stage: 'enumerate',
              code: 'no-router-root',
              message: 'tanstack-router detected but neither routeTree.gen.ts nor a routes directory was found',
            },
          ],
        };
      }
      drafts = fromRoutesDirectory(routesDir);
      strategy = 'file';
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'file-convention-fallback',
        message: 'no generated route tree; fell back to the routes directory convention',
      });
    }

    const screens = buildScreens(input.root, drafts, input.fileExports);
    const { edges } = buildCandidateEdges(input.root, screens, input.navIntents);
    return { screens, edges, strategy, diagnostics };
  },
};

function fromGeneratedTree(generated: string): ScreenDraft[] {
  let source: string;
  try {
    source = fs.readFileSync(generated, 'utf8');
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const drafts: ScreenDraft[] = [];
  for (const match of source.matchAll(FILE_ROUTE_CALL)) {
    const route = tanstackPathToRoute(match[1]!);
    if (seen.has(route)) continue;
    seen.add(route);
    drafts.push({
      route,
      pattern: match[1]!,
      kind: 'page',
      isPage: true,
      absolute: null,
      meta: { groups: [], dynamic: routeParams(route).length > 0, params: routeParams(route) },
    });
  }
  return drafts;
}

function fromRoutesDirectory(routesDir: string): ScreenDraft[] {
  const seen = new Set<string>();
  const drafts: ScreenDraft[] = [];

  for (const absolute of walkFiles(routesDir, { extensions: ROUTE_EXTENSIONS })) {
    const relative = path.relative(routesDir, absolute).split(path.sep).join('/');
    const parsed = flatFileRoute(relative);
    if (!parsed || parsed.pathless || seen.has(parsed.route)) continue;
    seen.add(parsed.route);
    drafts.push({
      route: parsed.route,
      pattern: relative,
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
  return drafts;
}

function resolveRoutesDir(root: string, routerRoot: string | null): string | null {
  const candidates = [
    routerRoot && !routerRoot.endsWith('.ts') ? routerRoot : null,
    'src/routes',
    'app/routes',
    'routes',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.map((dir) => path.join(root, dir)).find((dir) => isDirectory(dir)) ?? null;
}

/** TanStack paths use `$param` and `$` for a splat. */
function tanstackPathToRoute(routePath: string): string {
  const segments = routePath
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.+\)$/.test(segment) && !segment.startsWith('_'))
    .map((segment) => {
      if (segment === '$') return '*splat';
      if (segment.startsWith('$')) return `:${segment.slice(1)}`;
      return segment;
    });
  return segments.length ? `/${segments.join('/')}` : '/';
}
