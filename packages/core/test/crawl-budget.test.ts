import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import type { RendererProvider, RendererSession } from '../src/providers.js';
import { emptyDocument, type CrawlOutput, type JsxrayDocument } from '../src/index.js';
import { crawl } from '../src/stages/crawl.js';
import type {
  Clickable,
  FormGroup,
  Overlay,
  RenderStatus,
  SessionState,
} from '../src/runtime.js';

const BASE = 'http://localhost:9998';

/** Ten declared pages, each offering one link the walk has to click to find. */
const DECLARED = Array.from({ length: 10 }, (_, index) => `/page-${index}`);

class StubSession implements RendererSession {
  readonly rendererId = 'stub';
  readonly renderTarget = 'web' as const;
  readonly viewport = { width: 100, height: 100 };
  readonly deviceScaleFactor = 1;
  private current = '/page-0';

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
    return `fp:${this.current}`;
  }
  async renderStatus(): Promise<RenderStatus> {
    return 'ok';
  }
  async overlays(): Promise<Overlay[]> {
    return [];
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([1]);
  }
  async forms(): Promise<FormGroup[]> {
    return [];
  }

  /** Every declared page links to an undeclared one, reachable only by clicking. */
  async clickables(): Promise<Clickable[]> {
    if (!DECLARED.includes(this.current)) return [];
    return [
      {
        ref: `#found-${this.current}`,
        label: 'Deeper',
        target: `${this.current}/deeper`,
        role: 'link',
        inOverlay: false,
      },
    ];
  }

  async tap(ref: string): Promise<void> {
    this.current = `${ref.replace('#found-', '')}/deeper`;
  }
  async fill(): Promise<void> {}
  async sessionState(): Promise<SessionState | null> {
    return null;
  }
  async restoreSession(): Promise<void> {}
  async close(): Promise<void> {}
}

let outDir = '';
afterEach(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  outDir = '';
});

async function run(maxStates: number | null): Promise<CrawlOutput> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-budget-'));
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

  const document = emptyDocument('/tmp/app', 'test') as JsxrayDocument;
  document.screens = DECLARED.map((route) => ({
    id: route,
    route,
    isPage: true,
    meta: { groups: [] },
  })) as JsxrayDocument['screens'];

  return crawl({
    document,
    config: resolveConfig(
      {
        url: BASE,
        personas: [{ id: 'anon' }],
        seedRoutes: ['/page-0'],
        bounds: { maxDepth: 3, maxStates, actionCap: 4, timeoutMs: 20_000 },
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
}

describe('the state budget (§8)', () => {
  it('does not spend the walk budget on seeding the declared routes', async () => {
    // maxStates is 3, well under the 10 declared routes. Before, seeding ate it
    // and the walk never ran; the declared table is the app's own and finite.
    const { states } = await run(3);
    const seeded = states.filter((state) => DECLARED.includes(state.route));
    const walked = states.filter((state) => state.route.endsWith('/deeper'));

    expect(seeded).toHaveLength(10);
    expect(walked.length).toBeGreaterThan(0);
    expect(walked).toHaveLength(3);
  });

  it('still stops the walk at the ceiling', async () => {
    const { states, diagnostics } = await run(1);
    expect(states.filter((state) => state.route.endsWith('/deeper'))).toHaveLength(1);
    expect(diagnostics.some((entry) => entry.code === 'budget-exhausted')).toBe(true);
  });

  it('lifts the ceiling entirely when maxStates is null', async () => {
    // The default must not creep back in: `?? 120` would silently re-cap it.
    expect(resolveConfig({ bounds: { maxStates: null } }, null).bounds.maxStates).toBeNull();
    expect(resolveConfig({}, null).bounds.maxStates).toBe(120);

    const { states, diagnostics } = await run(null);
    expect(states.filter((state) => state.route.endsWith('/deeper'))).toHaveLength(10);
    expect(diagnostics.some((entry) => entry.code === 'budget-exhausted')).toBe(false);
  });
});
