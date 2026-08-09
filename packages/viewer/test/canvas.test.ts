import { describe, expect, it } from 'vitest';
import type { JsxrayDocument, ScreenState } from '@jsxray/core';
import { eyebrowOf, titleOf } from '../src/document.js';
import { FRAME_SIZE, buildGraph } from '../src/graph.js';
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
  overlays: [],
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
