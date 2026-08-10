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

describe('static pipeline over fixtures/react-router-config', () => {
  it('selects the config router rather than degrading', async () => {
    const document = await analyze('react-router-config');
    expect(document.framework?.router).toBe('react-router-config');
    expect(document.providers).toMatchObject({ router: 'react-router-config' });
    expect(document.stages.find((stage) => stage.name === 'enumerate')?.note).toBe('config');
  });

  it('reads a route array whose paths live in a constants module', async () => {
    const document = await analyze('react-router-config');
    const routes = document.screens.map((screen) => screen.route);
    expect(routes).toContain('/login');
    expect(routes).toContain('/services/:serviceName');
  });

  it('keeps a query string out of the route', async () => {
    const document = await analyze('react-router-config');
    expect(document.screens.map((screen) => screen.route)).toContain('/alerts');
  });

  it('joins a nested child onto its parent and folds the index route into it', async () => {
    const document = await analyze('react-router-config');
    const routes = document.screens.map((screen) => screen.route);
    expect(routes).toContain('/dashboard');
    expect(routes).toContain('/dashboard/settings');
    expect(routes).toContain('/dashboard/members/:memberId');
    expect(routes.filter((route) => route === '/dashboard')).toHaveLength(1);
  });

  it('reads a Route wrapped in a guard component, and drops the v5 param regex', async () => {
    const document = await analyze('react-router-config');
    expect(document.screens.map((screen) => screen.route)).toContain('/team/:teamId');
  });

  it('records an optional param as required rather than dropping the route', async () => {
    const document = await analyze('react-router-config');
    const help = document.screens.find((screen) => screen.route === '/help/:page');
    expect(help?.meta.params).toEqual(['page']);
  });

  it('nests a JSX Route inside its parent and canonicalizes the splat', async () => {
    const document = await analyze('react-router-config');
    const routes = document.screens.map((screen) => screen.route);
    expect(routes).toContain('/reports/quarterly');
    expect(routes).toContain('/*splat');
  });

  it('follows a lazy barrel export to the module that defines the component', async () => {
    const document = await analyze('react-router-config');
    const login = document.screens.find((screen) => screen.route === '/login');
    expect(login?.file).toBe('src/pages/Login.tsx');
    expect(login?.componentId).toBe('src/pages/Login.tsx#Login');
  });

  it('follows `export { default as X } from` for a re-exported page', async () => {
    const document = await analyze('react-router-config');
    const settings = document.screens.find((screen) => screen.route === '/dashboard/settings');
    expect(settings?.file).toBe('src/pages/Settings.tsx');
  });

  it('turns a Link into a candidate edge between two config routes', async () => {
    const document = await analyze('react-router-config');
    expect(document.edges).toContainEqual(
      expect.objectContaining({ from: '/dashboard', to: '/dashboard/settings', kind: 'link' }),
    );
  });
});

describe('static pipeline over fixtures/react-navigation', () => {
  it('selects the react-navigation router', async () => {
    const document = await analyze('react-navigation');
    expect(document.framework?.router).toBe('react-navigation');
    expect(document.providers).toMatchObject({ router: 'react-navigation' });
  });

  it('reads a flat screen-to-path map, including a screen with two paths', async () => {
    const document = await analyze('react-navigation');
    const routes = document.screens.map((screen) => screen.route).sort();
    expect(routes).toContain('/');
    expect(routes).toContain('/download');
    expect(routes).toContain('/profile/:name/feed/:rkey');
  });

  it('joins a nested linking config onto its parent path exactly once', async () => {
    const document = await analyze('react-navigation');
    const routes = document.screens.map((screen) => screen.route);
    expect(routes).toContain('/messages');
    expect(routes).toContain('/messages/inbox');
    expect(routes).toContain('/messages/:conversationId');
    // The nested tree must not also be read from its own `screens` key.
    expect(routes).not.toContain('/inbox');
    expect(routes).not.toContain('/:conversationId');
  });

  it('resolves a screen to a named export, which is how React Native writes one', async () => {
    const document = await analyze('react-navigation');
    const profile = document.screens.find((screen) => screen.route === '/profile/:name');
    expect(profile?.file).toBe('src/screens/Profile.tsx');
    expect(profile?.componentId).toBe('src/screens/Profile.tsx#ProfileScreen');
  });

  it('turns navigate(screenName) into an edge to that screen route (§4.1)', async () => {
    const document = await analyze('react-navigation');
    expect(document.edges).toContainEqual(
      expect.objectContaining({ from: '/', to: '/profile/:name/feed/:rkey', kind: 'push' }),
    );
  });

  it('reports how many named targets it resolved', async () => {
    const document = await analyze('react-navigation');
    const diagnostic = document.diagnostics.find(
      (candidate) => candidate.code === 'named-targets-resolved',
    );
    expect(diagnostic?.message).toMatch(/navigate\(\) calls target a screen name/);
  });
});
