import { describe, expect, it } from 'vitest';
import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import type { Edge } from '@jsxray/core';
import { eyebrowOf, titleOf, transitionOf } from '../src/document.js';
import { FRAME_SIZE, buildGraph, findHiddenLinks } from '../src/graph.js';
import { layoutGraph } from '../src/layout.js';

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
  captureSkipped: captured ? null : 'privacy',
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

describe('graph', () => {
  it('draws runtime edges only', () => {
    const { edges } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    expect(edges.map((edge) => edge.id)).toEqual(['/->/settings', '/settings->/settings$rename-workspace']);
  });

  it('makes one node per state, so an overlay is its own node', () => {
    const { nodes } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    expect(nodes.map((node) => node.id).sort()).toEqual(
      ['/', '/settings', '/settings$rename-workspace'].sort(),
    );
  });

  it('filters to one persona and merges variants otherwise', () => {
    expect(buildGraph({ document, personaId: 'admin', frame: 'browser' }).nodes).toHaveLength(1);
    const all = buildGraph({ document, personaId: null, frame: 'browser' });
    expect(all.nodes.find((node) => node.id === '/')?.data).toMatchObject({ variants: expect.any(Array) });
  });

  it('sizes every frame identically so a later capture shifts no layout', () => {
    const { nodes } = buildGraph({ document, personaId: 'user', frame: 'phone' });
    expect(new Set(nodes.map((node) => node.height))).toEqual(new Set([FRAME_SIZE.phone.height]));
  });
});

describe('edge anatomy', () => {
  it('names an edge by the transition, not by the words on the control', () => {
    const { edges } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    expect(edges.map((edge) => edge.label)).toEqual([
      'Navigate to /settings',
      'Open the rename workspace dialog',
    ]);
  });

  it('falls back to the control, shortened, when nothing structural changed', () => {
    const from = state('/feed', 'user', true);
    const to = { ...state('/feed', 'user', true), fingerprint: 'def' };
    expect(transitionOf(from, to, edge('View this user’s verifications'))).toBe(
      'View this user’s verifications',
    );
    expect(transitionOf(from, to, edge('a'.repeat(60)))).toBe(`${'a'.repeat(39)}…`);
  });

  it('names a closed overlay too', () => {
    const open = state('/settings$rename-workspace', 'user', true, '/settings');
    const shut = state('/settings', 'user', true);
    expect(transitionOf(open, shut, edge('Cancel'))).toBe('Close the rename workspace dialog');
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
  });
});

describe('layout', () => {
  it('positions every node without overlap', async () => {
    const { nodes, edges } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    const laid = await layoutGraph(nodes, edges);

    expect(laid).toHaveLength(3);
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
    const { nodes, edges } = buildGraph({ document, personaId: 'user', frame: 'browser' });
    const laid = await layoutGraph(nodes, edges);
    const byId = new Map(laid.map((node) => [node.id, node.position.x]));
    expect(byId.get('/')!).toBeLessThan(byId.get('/settings')!);
    expect(byId.get('/settings')!).toBeLessThan(byId.get('/settings$rename-workspace')!);
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
    expect(graph.edges.map((edge) => edge.id)).toEqual(['/->/settings']);
    expect(graph.hiddenLinks).toBe(1);
  });

  it('lays a cyclic graph out without hanging or overlapping', async () => {
    const { nodes, edges } = buildGraph({ document: cyclic, personaId: 'user', frame: 'browser' });
    const laid = await layoutGraph(nodes, edges);
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
    const laid = await layoutGraph(graph.nodes, graph.edges);
    expect(laid).toHaveLength(1);
    expect(Number.isFinite(laid[0]!.position.x)).toBe(true);
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
