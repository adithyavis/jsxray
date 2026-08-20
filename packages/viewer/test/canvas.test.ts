import { describe, expect, it } from 'vitest';
import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import type { Edge } from '@jsxray/core';
import type { Node } from '@xyflow/react';
import { eyebrowOf, titleOf } from '../src/document.js';
import { FRAME_SIZE, buildGraph, findHiddenLinks, nodeId, type GraphLane } from '../src/graph.js';
import { layoutGraph, layoutLanes } from '../src/layout.js';

const state = (
  signature: string,
  personaId: string,
  captured: boolean,
  route = signature.split('$')[0]!,
): ScreenState => ({
  signature,
  screenId: route,
  route,
  url: `http://localhost:3000${route}`,
  personaId,
  overlays: signature
    .split('$')
    .slice(1)
    .map((name) => ({ name, role: 'dialog', via: 'role' as const })),
  capture: captured
    ? {
        path: `assets/${personaId}/x.png`,
        renderer: 'playwright',
        renderTarget: 'web',
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      }
    : null,
  captureStatus: captured ? 'ok' : 'privacy',
  untriedActions: [],
  reachedVia: [{ kind: 'goto', target: route }],
  deadActions: [],
  fingerprint: 'abc',
  depth: 0,
});

const edge = (label: string): Edge => ({
  id: 'x',
  discoveredBy: 'runtime',
  kind: 'action',
  from: '/feed',
  to: '/feed',
  label,
  matchKey: '/feed /feed',
});

const document = {
  schemaVersion: 1,
  screens: [
    { id: '/', route: '/', isPage: true, meta: { groups: [] } },
    { id: '/settings', route: '/settings', isPage: true, meta: { groups: ['account'] } },
    { id: '/api/health#route-handler', route: '/api/health', isPage: false, meta: { groups: [] } },
  ],
  states: [
    state('/', 'user', true),
    state('/settings', 'user', true),
    state('/settings$rename-workspace', 'user', true, '/settings'),
    state('/', 'admin', true),
  ],
  edges: [
    {
      id: 'e1',
      discoveredBy: 'runtime',
      kind: 'action',
      from: '/',
      to: '/settings',
      fromState: '/',
      toState: '/settings',
      label: 'Settings',
      personaId: 'user',
      matchKey: '/ /settings',
    },
    {
      id: 'e2',
      discoveredBy: 'runtime',
      kind: 'action',
      from: '/settings',
      to: '/settings',
      fromState: '/settings',
      toState: '/settings$rename-workspace',
      label: 'Rename workspace',
      personaId: 'user',
      matchKey: '/settings /settings',
    },
    {
      id: 'e3',
      discoveredBy: 'static',
      kind: 'link',
      from: '/',
      to: '/settings',
      label: 'Settings',
      matchKey: '/ /settings',
    },
  ],
  personas: [{ id: 'user', authenticated: true }],
} as unknown as JsxrayDocument;

const screenNodes = (graph: ReturnType<typeof buildGraph>): Node[] =>
  graph.lanes.flatMap((lane) => lane.nodes);

describe('graph', () => {
  it('draws runtime edges only', () => {
    const { edges } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    expect(edges.map((edge) => edge.id)).toEqual(['user::/->/settings']);
  });

  it('folds an overlay onto its screen, so a dialog is not a node', () => {
    const graph = buildGraph({ document, personaId: 'user', frame: 'browser' });
    expect(screenNodes(graph).map((node) => node.id).sort()).toEqual(
      ['user::/', 'user::/settings'].sort(),
    );
  });

  it('draws no line for opening a dialog, because it goes nowhere on the canvas', () => {
    const graph = buildGraph({ document, personaId: 'user', frame: 'browser' });
    const settings = screenNodes(graph).find((node) => node.id === 'user::/settings')!;
    expect(graph.edges.some((edge) => edge.target === 'user::/settings$rename-workspace')).toBe(
      false,
    );
    expect((settings.data as { outbound: number }).outbound).toBe(0);
  });

  it('keeps a line that leaves a dialog for another screen', () => {
    const throughDialog = {
      ...document,
      states: [
        state('/settings', 'user', true),
        state('/settings$rename-workspace', 'user', true, '/settings'),
        state('/settings/billing', 'user', true),
      ],
      edges: [
        {
          id: 'd1',
          discoveredBy: 'runtime',
          kind: 'action',
          from: '/settings',
          to: '/settings',
          fromState: '/settings',
          toState: '/settings$rename-workspace',
          label: 'Rename workspace',
          personaId: 'user',
          matchKey: '/settings /settings',
        },
        {
          id: 'd2',
          discoveredBy: 'runtime',
          kind: 'action',
          from: '/settings',
          to: '/settings/billing',
          fromState: '/settings$rename-workspace',
          toState: '/settings/billing',
          label: 'Manage billing',
          personaId: 'user',
          matchKey: '/settings /settings/billing',
        },
      ],
    } as unknown as JsxrayDocument;

    const graph = buildGraph({ document: throughDialog, personaId: 'user', frame: 'browser' });
    expect(screenNodes(graph).map((node) => node.id).sort()).toEqual(
      ['user::/settings', 'user::/settings/billing'].sort(),
    );
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      'user::/settings->/settings/billing',
    ]);
  });

  it('keeps an overlay the crawl never saw the screen under, or the screen is lost', () => {
    const onlyOverlay = {
      ...document,
      states: [state('/', 'user', true), state('/settings$rename-workspace', 'user', true, '/settings')],
      edges: [
        {
          id: 'o1',
          discoveredBy: 'runtime',
          kind: 'action',
          from: '/',
          to: '/settings',
          fromState: '/',
          toState: '/settings$rename-workspace',
          label: 'Rename workspace',
          personaId: 'user',
          matchKey: '/ /settings',
        },
      ],
    } as unknown as JsxrayDocument;

    const graph = buildGraph({ document: onlyOverlay, personaId: 'user', frame: 'browser' });
    expect(screenNodes(graph).map((node) => node.id).sort()).toEqual(
      ['user::/', 'user::/settings$rename-workspace'].sort(),
    );
  });

  it('filters to one persona', () => {
    const graph = buildGraph({ document, personaId: 'admin', frame: 'browser' });
    expect(graph.lanes.map((lane) => lane.personaId)).toEqual(['admin']);
    expect(screenNodes(graph)).toHaveLength(1);
  });

  it('gives every persona its own lane rather than merging them', () => {
    const all = buildGraph({ document, personaId: null, frame: 'browser' });
    expect(all.lanes.map((lane) => lane.personaId)).toEqual(['user', 'admin']);

    // Both personas reached `/`. That is two nodes, each holding its own capture.
    const home = screenNodes(all).filter((node) => node.id.endsWith('::/'));
    expect(home.map((node) => node.id)).toEqual([nodeId('user', '/'), nodeId('admin', '/')]);
    expect(new Set(home.map((node) => (node.data as { state: ScreenState }).state))).toHaveProperty(
      'size',
      2,
    );
  });

  it('never draws an edge between two personas', () => {
    const all = buildGraph({ document, personaId: null, frame: 'browser' });
    for (const lane of all.lanes) {
      const ours = new Set(lane.nodes.map((node) => node.id));
      for (const edge of lane.edges) {
        expect(ours.has(edge.source) && ours.has(edge.target)).toBe(true);
      }
    }
  });

  it('sizes every frame identically so a later capture shifts no layout', () => {
    const graph = buildGraph({ document, personaId: 'user', frame: 'phone' });
    expect(new Set(screenNodes(graph).map((node) => node.height))).toEqual(
      new Set([FRAME_SIZE.phone.height]),
    );
  });
});

describe('node anatomy', () => {
  it('titles an overlay by its own name, not the screen underneath', () => {
    expect(titleOf('/settings$rename-workspace')).toBe('Rename Workspace');
    expect(titleOf('/')).toBe('Home');
    expect(titleOf('/posts/:id')).toBe('Posts Detail');
    expect(titleOf('/*slug')).toBe('Slug');
    expect(titleOf('/#not-found')).toBe('Not Found');
  });

  it('prefers the router grouping for the eyebrow', () => {
    const settings = document.screens.find((screen) => screen.id === '/settings')!;
    expect(eyebrowOf(settings, '/settings')).toBe('ACCOUNT');
    expect(eyebrowOf(null, '/dashboard/settings')).toBe('DASHBOARD');
    expect(eyebrowOf(null, '/')).toBeNull();
    // A parameter is not a part of the app, so the section walks past it.
    expect(eyebrowOf(null, '/profile/:name/post/:rkey')).toBe('POST');
    expect(eyebrowOf(null, '/:name/:rkey')).toBeNull();
  });
});

describe('layout', () => {
  const laneOne = (): GraphLane =>
    buildGraph({ document, personaId: 'user', frame: 'browser' }).lanes[0]!;

  it('positions every node without overlap', async () => {
    const { nodes, edges } = laneOne();
    const laid = await layoutGraph(nodes, edges);

    expect(laid).toHaveLength(2);
    for (const node of laid) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }

    for (let a = 0; a < laid.length; a++) {
      for (let b = a + 1; b < laid.length; b++) {
        expect(overlaps(laid[a]!, laid[b]!)).toBe(false);
      }
    }
  });

  it('lays a tree out left to right', async () => {
    const { nodes, edges } = laneOne();
    const laid = await layoutGraph(nodes, edges);
    const byId = new Map(laid.map((node) => [node.id, node.position.x]));
    expect(byId.get('user::/')!).toBeLessThan(byId.get('user::/settings')!);
  });

  it('leaves room between depths for the edge and its label', async () => {
    const { nodes, edges } = laneOne();
    const laid = await layoutGraph(nodes, edges);
    const byId = new Map(laid.map((node) => [node.id, node.position.x]));
    const gap = byId.get('user::/settings')! - byId.get('user::/')! - FRAME_SIZE.browser.width;
    expect(gap).toBeGreaterThanOrEqual(200);
  });
});

describe('lanes', () => {
  it('stacks each persona below the last, and heads it with the persona', async () => {
    const graph = buildGraph({ document, personaId: null, frame: 'browser' });
    const laid = await layoutLanes(graph.lanes);

    expect(laid.filter((node) => node.type === 'lane').map((node) => node.id)).toEqual([
      'lane::user',
      'lane::admin',
    ]);

    const bottomOf = (personaId: string): number =>
      Math.max(
        ...laid
          .filter((node) => node.id.startsWith(`${personaId}::`))
          .map((node) => node.position.y + (node.height ?? 0)),
      );
    const topOf = (personaId: string): number =>
      Math.min(
        ...laid
          .filter((node) => node.id.startsWith(`${personaId}::`))
          .map((node) => node.position.y),
      );

    expect(bottomOf('user')).toBeLessThan(topOf('admin'));
  });

  it('heads nothing when only one persona is drawn', async () => {
    const graph = buildGraph({ document, personaId: 'user', frame: 'browser' });
    const laid = await layoutLanes(graph.lanes);
    expect(laid.some((node) => node.type === 'lane')).toBe(false);
    expect(laid).toHaveLength(2);
  });
});

function overlaps(a: { position: { x: number; y: number }; width?: number; height?: number }, b: typeof a): boolean {
  const aw = a.width ?? 0;
  const ah = a.height ?? 0;
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  return (
    a.position.x < b.position.x + bw &&
    a.position.x + aw > b.position.x &&
    a.position.y < b.position.y + bh &&
    a.position.y + ah > b.position.y
  );
}

describe('cycles', () => {
  const cyclic = {
    ...document,
    states: [state('/', 'user', true), state('/settings', 'user', true)],
    edges: [
      {
        id: 'c1',
        discoveredBy: 'runtime',
        kind: 'action',
        from: '/',
        to: '/settings',
        fromState: '/',
        toState: '/settings',
        label: 'Settings',
        personaId: 'user',
        matchKey: '/ /settings',
      },
      {
        id: 'c2',
        discoveredBy: 'runtime',
        kind: 'action',
        from: '/settings',
        to: '/',
        fromState: '/settings',
        toState: '/',
        label: 'Home',
        personaId: 'user',
        matchKey: '/settings /',
      },
    ],
  } as unknown as JsxrayDocument;

  it('does not draw the link back to a screen already visited', () => {
    const graph = buildGraph({ document: cyclic, personaId: 'user', frame: 'browser' });
    expect(graph.edges.map((edge) => edge.id)).toEqual(['user::/->/settings']);
    expect(graph.hiddenLinks).toBe(1);
  });

  it('lays a cyclic graph out without hanging or overlapping', async () => {
    const graph = buildGraph({ document: cyclic, personaId: 'user', frame: 'browser' });
    const laid = await layoutLanes(graph.lanes);
    expect(laid).toHaveLength(2);
    for (const node of laid) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    expect(overlaps(laid[0]!, laid[1]!)).toBe(false);
  });

  it('drops a self-loop rather than drawing it', async () => {
    const selfLoop = {
      ...cyclic,
      states: [state('/', 'user', true)],
      edges: [
        {
          id: 's1',
          discoveredBy: 'runtime',
          kind: 'action',
          from: '/',
          to: '/',
          fromState: '/',
          toState: '/',
          label: 'Refresh',
          personaId: 'user',
          matchKey: '/ /',
        },
      ],
    } as unknown as JsxrayDocument;
    const graph = buildGraph({ document: selfLoop, personaId: 'user', frame: 'browser' });
    expect(graph.edges).toHaveLength(0);
    expect(graph.hiddenLinks).toBe(1);
    const laid = await layoutLanes(graph.lanes);
    expect(laid).toHaveLength(1);
    expect(Number.isFinite(laid[0]!.position.x)).toBe(true);
  });
});

describe('findHiddenLinks roots at the seed', () => {
  // The Bluesky shape: a seeded dead end links to Home, and Home is linked to from
  // everywhere. By in-degree the dead end is the root and Home hangs under it.
  const pairs = ['/support->/', '/support->/search', '/->/feeds', '/feeds->/'];

  it('keeps the seed on top even though the app links back to it', () => {
    const hidden = findHiddenLinks(pairs, ['/']);
    const drawn = pairs.filter((pair) => !hidden.has(pair));
    expect(drawn).toContain('/->/feeds');
    expect(drawn).not.toContain('/support->/');
  });

  it('falls back to in-degree when no seed is on the canvas', () => {
    const hidden = findHiddenLinks(pairs, ['/never-crawled']);
    expect(pairs.filter((pair) => !hidden.has(pair))).toContain('/support->/');
  });

  it('takes the seeds from the document', () => {
    const seeded = {
      ...document,
      seedRoutes: ['/settings'],
      states: [...document.states, state('/settings/billing', 'user', true)],
      edges: [
        ...document.edges,
        {
          id: 'e4',
          discoveredBy: 'runtime',
          kind: 'action',
          from: '/settings',
          to: '/settings/billing',
          fromState: '/settings',
          toState: '/settings/billing',
          label: 'Billing',
          personaId: 'user',
          matchKey: '/settings /settings/billing',
        },
      ],
    } as unknown as JsxrayDocument;
    const { lanes } = buildGraph({ document: seeded, personaId: 'user', frame: 'browser' });
    // `/ -> /settings` is dropped: /settings is the root, so it needs no line in.
    expect(lanes[0]!.edges.map((edge) => edge.id)).toEqual(['user::/settings->/settings/billing']);
  });
});

describe('findHiddenLinks', () => {
  it('draws the short way in, not the long one', () => {
    const hidden = findHiddenLinks([
      '/->/welcome',
      '/welcome->/dashboard',
      '/->/dashboard',
    ]);
    expect([...hidden]).toEqual(['/welcome->/dashboard']);
  });

  it('gives every screen exactly one line in', () => {
    const pairs = ['/->/a', '/->/b', '/a->/c', '/b->/c', '/c->/a'];
    const hidden = findHiddenLinks(pairs);
    const drawn = pairs.filter((pair) => !hidden.has(pair));
    const targets = drawn.map((pair) => pair.split('->')[1]);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('drops the long way back in Home -> Settings -> Profile -> Home', () => {
    const hidden = findHiddenLinks(['/->/settings', '/settings->/profile', '/profile->/']);
    expect([...hidden]).toEqual(['/profile->/']);
  });

  it('drops every menu link back to home', () => {
    const hidden = findHiddenLinks(['/->/a', '/a->/b', '/b->/c', '/a->/', '/b->/', '/c->/']);
    expect(hidden.size).toBe(3);
  });

  it('still reaches screens in a loop that has no way in', () => {
    const pairs = ['/a->/b', '/b->/a'];
    const hidden = findHiddenLinks(pairs);
    expect(hidden.size).toBe(1);
    expect([...hidden]).toEqual(['/b->/a']);
  });

  it('draws separate islands', () => {
    const hidden = findHiddenLinks(['/a->/b', '/x->/y']);
    expect(hidden.size).toBe(0);
  });
});
