import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig, run, type JsxrayDocument } from '@jsxray/core';
import { registry } from '@jsxray/providers';
// @ts-expect-error -- a plain .mjs fixture, deliberately not typed
import { startFixtureApp } from '../../../fixtures/runtime-app/server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let app: { url: string; close(): Promise<void> };
let outDir: string;
let document: JsxrayDocument;
/** A capture left by an earlier run, to prove the crawl clears it. */
let stale: string;
let staleOtherPersona: string;

beforeAll(async () => {
  app = await startFixtureApp(0);
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-crawl-'));

  stale = path.join(outDir, 'assets', 'anon', 'gone-from-the-app.png');
  staleOtherPersona = path.join(outDir, 'assets', 'ghost', 'not-crawled.png');
  for (const file of [stale, staleOtherPersona]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not a real png');
  }

  process.env.JSXRAY_TEST_USER = 'user@example.com';
  process.env.JSXRAY_TEST_ADMIN = 'admin@example.com';
  process.env.JSXRAY_TEST_PW = 'hunter2';

  document = await run({
    root: path.join(repoRoot, 'fixtures', 'next-app'),
    outDir,
    version: 'test',
    registry,
    // enumerate too: the crawl needs the declared routes to tell a screen from a
    // route handler, which is the difference between a node and a blank capture.
    stages: ['parse', 'enumerate', 'crawl'],
    url: app.url,
    config: resolveConfig(
      {
        url: app.url,
        personas: [
          { id: 'anon' },
          {
            id: 'user',
            login: {
              username: { __jsxrayEnv: 'JSXRAY_TEST_USER' },
              password: { __jsxrayEnv: 'JSXRAY_TEST_PW' },
            },
          },
          {
            id: 'admin',
            login: {
              username: { __jsxrayEnv: 'JSXRAY_TEST_ADMIN' },
              password: { __jsxrayEnv: 'JSXRAY_TEST_PW' },
            },
          },
        ],
        seedRoutes: ['/', '/settings', '/signup', '/secrets', '/billing'],
        ignore: { screenshots: ['/secrets'] },
        bounds: { maxDepth: 3, maxStates: 40, actionCap: 8, timeoutMs: 120_000 },
      },
      null,
    ),
  });
}, 300_000);

afterAll(async () => {
  await app?.close();
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

const signatures = (personaId: string): string[] =>
  document.states.filter((state) => state.personaId === personaId).map((state) => state.signature);

describe('crawl', () => {
  it('logs each persona in and reaches gated screens', () => {
    expect(signatures('user')).toContain('/dashboard');
    expect(signatures('anon')).not.toContain('/dashboard');
  });

  it('separates personas by what they actually saw', () => {
    expect(signatures('admin')).toContain('/admin');
    expect(signatures('user')).not.toContain('/admin');
  });

  it('gives an overlay its own state, named after its accessible name', () => {
    expect(signatures('user')).toContain('/settings$rename-workspace');
  });

  it('clears a crawled persona’s stale captures, and leaves other personas alone', () => {
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(staleOtherPersona)).toBe(true);
  });

  it('keeps every capture the document points at', () => {
    const referenced = document.states
      .filter((state) => state.capture)
      .map((state) => path.join(outDir, state.capture!.path));
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((file) => !fs.existsSync(file))).toEqual([]);
  });

  it('writes a capture per state and records the renderer that produced it', () => {
    const dashboard = document.states.find(
      (state) => state.signature === '/dashboard' && state.personaId === 'user',
    );
    expect(dashboard?.capture?.renderer).toBe('playwright');
    expect(fs.existsSync(path.join(outDir, dashboard!.capture!.path))).toBe(true);
  });

  it('visits an ignore.screenshots route but never captures it', () => {
    const secrets = document.states.find((state) => state.route === '/secrets');
    expect(secrets).toBeDefined();
    expect(secrets?.capture).toBeNull();
    expect(secrets?.captureSkipped).toBe('privacy');
  });

  it('never makes a screen of a route handler, linked or redirected to', () => {
    expect(document.states.some((state) => state.route === '/api/health')).toBe(false);
    expect(document.states.some((state) => state.url.endsWith('/api/health'))).toBe(false);
    expect(
      document.diagnostics.filter((diagnostic) => diagnostic.code === 'route-handler-landing')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('reports a screen that rendered nothing instead of writing a blank capture', () => {
    const blank = document.states.find((state) => state.route === '/blank');
    expect(blank).toBeDefined();
    expect(blank?.capture).toBeNull();
    expect(blank?.captureSkipped).toBe('blank');
    expect(document.diagnostics.some((diagnostic) => diagnostic.code === 'blank-render')).toBe(true);
  });

  it('never clicks logout, by label or by target', () => {
    expect(document.states.some((state) => state.route === '/logout')).toBe(false);
    expect(signatures('user')).toContain('/dashboard');
  });

  it('records runtime edges only for traversed interactions', () => {
    const runtimeEdges = document.edges.filter((edge) => edge.discoveredBy === 'runtime');
    expect(runtimeEdges.length).toBeGreaterThan(0);
    expect(runtimeEdges.every((edge) => edge.fromState && edge.toState)).toBe(true);
    expect(
      runtimeEdges.some(
        (edge) => edge.fromState === '/settings' && edge.toState === '/settings$rename-workspace',
      ),
    ).toBe(true);
  });

  it('synthesizes a form and walks through it', () => {
    expect(document.states.some((state) => state.route === '/welcome')).toBe(true);
  });

  it('refuses a payment form and says so', () => {
    expect(
      document.diagnostics.some((diagnostic) => diagnostic.code === 'form-skipped-payment-field'),
    ).toBe(true);
    expect(document.states.some((state) => state.route === '/welcome')).toBe(true);
  });

  it('stores the steps that reached each state, for replay and for the inspector', () => {
    const overlay = document.states.find(
      (state) => state.signature === '/settings$rename-workspace',
    );
    expect(overlay?.reachedVia.length).toBeGreaterThan(0);
    expect(overlay?.reachedVia[0]?.kind).toBe('goto');
  });

  it('computes coverage per persona', () => {
    expect(document.coverage?.byPersona.user?.screensReached).toBeGreaterThan(0);
    expect(document.coverage?.byPersona.anon?.screensReached).toBeGreaterThan(0);
  });
});
