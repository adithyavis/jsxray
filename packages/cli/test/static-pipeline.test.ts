import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig, run, type JsxrayDocument } from '@jsxray/core';
import { registry } from '@jsxray/providers';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function analyze(fixture: string): Promise<JsxrayDocument> {
  const root = path.join(repoRoot, 'fixtures', fixture);
  return run({
    root,
    outDir: path.join(root, '.jsxray'),
    config: resolveConfig({}, null),
    registry,
    version: 'test',
    staticOnly: true,
  });
}

describe('static pipeline over fixtures/next-app', () => {
  it('detects the stack from source alone', async () => {
    const document = await analyze('next-app');
    expect(document.framework?.ui).toBe('react');
    expect(document.framework?.metaFramework).toBe('next');
    expect(document.framework?.router).toBe('next-app');
    expect(document.providers).toMatchObject({ parser: 'react', router: 'next' });
  });

  it('enumerates every route shape and no others', async () => {
    const document = await analyze('next-app');
    const ids = document.screens.map((screen) => screen.id).sort();
    expect(ids).toEqual(
      [
        '/',
        '/#not-found',
        '/about',
        '/api/health#route-handler',
        '/dashboard',
        '/dashboard/settings',
        '/docs/*slug',
        '/posts/:id',
      ].sort(),
    );
  });

  it('keeps a route group out of the URL but records it', async () => {
    const document = await analyze('next-app');
    const about = document.screens.find((screen) => screen.id === '/about');
    expect(about?.meta.groups).toEqual(['marketing']);
  });

  it('marks non-page screens so they are never crawled or drawn', async () => {
    const document = await analyze('next-app');
    const nonPages = document.screens.filter((screen) => !screen.isPage).map((s) => s.id);
    expect(nonPages.sort()).toEqual(['/#not-found', '/api/health#route-handler']);
  });

  it('resolves each route file to the component it mounts', async () => {
    const document = await analyze('next-app');
    const home = document.screens.find((screen) => screen.id === '/');
    expect(home?.componentId).toBe('app/page.tsx#HomePage');
    expect(home?.layoutComponentIds).toEqual(['app/layout.tsx#RootLayout']);
  });

  it('records candidate edges and leaves the canvas to the runtime half', async () => {
    const document = await analyze('next-app');
    const candidates = document.edges.filter((edge) => edge.discoveredBy === 'static');
    expect(candidates.length).toBeGreaterThan(0);
    expect(document.edges.some((edge) => edge.discoveredBy === 'runtime')).toBe(false);
    expect(candidates.some((edge) => edge.to === '/dashboard')).toBe(true);
    expect(candidates.some((edge) => edge.kind === 'push' && edge.to === '/posts/:id')).toBe(true);
  });

  it('reports coverage with no runtime denominator filled in', async () => {
    const document = await analyze('next-app');
    expect(document.coverage?.overall.screensDeclared).toBe(6);
    expect(document.coverage?.overall.screensReached).toBe(0);
    expect(document.stages.find((stage) => stage.name === 'crawl')?.status).toBe('skipped');
  });
});

describe('static pipeline over fixtures/monorepo', () => {
  it('parses a workspace package as source, not as an opaque dependency', async () => {
    const document = await analyze('monorepo');
    expect(document.framework?.workspaces.map((entry) => entry.name)).toEqual(['@acme/ui']);
    expect(
      document.components.some((component) => component.file === 'packages/ui/src/card.tsx'),
    ).toBe(true);
  });

  it('follows `export { default } from` to the real component', async () => {
    const document = await analyze('monorepo');
    const team = document.screens.find((screen) => screen.id === '/team');
    expect(team?.componentId).toBe('packages/ui/src/team-screen.tsx#TeamScreen');
  });
});
