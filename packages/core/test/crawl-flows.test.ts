import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import type { RendererProvider, RendererSession } from '../src/providers.js';
import { emptyDocument, type CrawlOutput } from '../src/index.js';
import { crawl } from '../src/stages/crawl.js';
import type {
  Clickable,
  FormGroup,
  Overlay,
  RenderStatus,
  SessionState,
} from '../src/runtime.js';

const BASE = 'http://localhost:9995';

/**
 * A login screen whose submit control the collector never reports — because it
 * renders a beat after the form, which is how most of them behave.
 */
class StubSession implements RendererSession {
  readonly rendererId = 'stub';
  readonly renderTarget = 'web' as const;
  readonly viewport = { width: 100, height: 100 };
  readonly deviceScaleFactor = 1;

  readonly taps: string[] = [];
  readonly fills: string[] = [];
  private current = '/login';

  async freeze(): Promise<void> {}
  async goto(target: string): Promise<void> {
    this.current = target.startsWith(BASE) ? target.slice(BASE.length) : target;
  }
  async settle(): Promise<void> {}
  /** Old enough that the capture floor never waits — these tests are not about it. */
  pageAge(): number {
    return Number.MAX_SAFE_INTEGER;
  }
  async url(): Promise<string> {
    return `${BASE}${this.current}`;
  }
  async fingerprint(): Promise<string> {
    return this.current;
  }
  async renderStatus(): Promise<RenderStatus> {
    return 'ok';
  }
  async overlays(): Promise<Overlay[]> {
    return [];
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0]);
  }
  /** Deliberately empty: nothing the flow touches is ever collected. */
  async clickables(): Promise<Clickable[]> {
    return [];
  }
  async forms(): Promise<FormGroup[]> {
    return [];
  }

  async tap(ref: string): Promise<void> {
    this.taps.push(ref);
    if (ref === '#submit') this.current = '/dashboard';
  }
  async fill(ref: string): Promise<void> {
    this.fills.push(ref);
  }
  async session(): Promise<SessionState> {
    return null;
  }
  async restore(): Promise<void> {}
  async close(): Promise<void> {}
}

let outDir = '';
afterEach(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  outDir = '';
});

async function run(): Promise<CrawlOutput & { taps: string[]; fills: string[] }> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-flows-'));
  const session = new StubSession();
  const renderer: RendererProvider = {
    axis: 'renderer',
    id: 'stub',
    priority: 1,
    capabilities: {
      renderTargets: ['web'],
      sessionPersistence: false,
      determinismFreeze: true,
      elementBoxes: false,
    },
    supports: () => true,
    launch: async () => session,
  };

  const output = await crawl({
    document: emptyDocument('/tmp/app', 'test'),
    config: resolveConfig(
      {
        url: BASE,
        personas: [{ id: 'anon' }],
        seedRoutes: ['/login'],
        flows: [
          {
            id: 'sign-in',
            start: '/login',
            steps: [{ fill: { '#email': 'a@b.c' } }, { submit: '#submit' }],
          },
        ],
        bounds: { maxDepth: 3, maxStates: 10, actionCap: 4, timeoutMs: 10_000 },
        capture: { delayMs: 0 },
      },
      null,
    ),
    renderer,
    auth: null,
    outDir,
    baseUrl: BASE,
    headed: false,
    personaIds: null,
    log: () => undefined,
  });

  return { ...output, taps: session.taps, fills: session.fills };
}

describe('a named flow', () => {
  it('presses a control the collector never reported', async () => {
    // The stale-ref rule belongs to the walk, which asks the page what is on it
    // first. A flow names its own controls, and one that has not rendered yet is
    // not one that is gone — refusing it here breaks every login.
    const { taps, fills, diagnostics } = await run();

    expect(fills).toEqual(['#email']);
    expect(taps).toEqual(['#submit']);
    expect(diagnostics.filter((entry) => entry.code === 'flow-failed')).toEqual([]);
  });

  it('reaches the state the flow exists to reach', async () => {
    const { states } = await run();
    expect(states.map((state) => state.route)).toContain('/dashboard');
  });
});
