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

const BASE = 'http://localhost:9999';

/** Two links, and the first of them navigates away — the taxonomy `/login` shape. */
const PAGES: Record<string, Clickable[]> = {
  '/login': [
    { ref: '#github', label: 'Github', target: '/oauth', role: 'link', inOverlay: false },
    { ref: '#signup', label: 'Sign Up', target: '/register', role: 'link', inOverlay: false },
  ],
  '/oauth': [],
  '/register': [],
};

interface StubOptions {
  /** Tapping this ref starts a navigation that leaves `goto` unable to land. */
  breakOn?: string;
}

class StubSession implements RendererSession {
  readonly rendererId = 'stub';
  readonly renderTarget = 'web' as const;
  readonly viewport = { width: 100, height: 100 };
  readonly deviceScaleFactor = 1;

  readonly taps: string[] = [];
  private current = '/login';
  private broken = false;

  constructor(private readonly options: StubOptions) {}

  async freeze(): Promise<void> {}

  async goto(target: string): Promise<void> {
    if (this.broken) throw new Error('page.goto: net::ERR_ABORTED');
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
  async clickables(): Promise<Clickable[]> {
    return PAGES[this.current] ?? [];
  }
  async forms(): Promise<FormGroup[]> {
    return [];
  }

  async tap(ref: string): Promise<void> {
    this.taps.push(ref);
    if (ref === this.options.breakOn) {
      this.broken = true;
      this.current = '/oauth';
      return;
    }
    const target = (PAGES[this.current] ?? []).find((link) => link.ref === ref)?.target;
    if (target) this.current = target;
  }

  async fill(): Promise<void> {}
  async session(): Promise<SessionState> {
    return null;
  }
  async restore(): Promise<void> {}
  async close(): Promise<void> {}
}

let outDir: string | null = null;

afterEach(() => {
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  outDir = null;
});

async function run(options: StubOptions): Promise<CrawlOutput & { taps: string[] }> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-recovery-'));
  const session = new StubSession(options);
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
        bounds: { maxDepth: 3, maxStates: 10, actionCap: 8, timeoutMs: 10_000 },
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

  return { ...output, taps: session.taps };
}

describe('a state the crawl cannot get back to', () => {
  it('stops working it instead of firing the rest of its actions elsewhere', async () => {
    const { taps, edges } = await run({ breakOn: '#github' });

    // The action behind the one that navigated away is never attempted: its ref is
    // a path into a DOM the crawl has left.
    expect(taps).toContain('#github');
    expect(taps).not.toContain('#signup');
    expect(edges.some((edge) => edge.to === '/register')).toBe(false);
  });

  it('reports how many actions went untried, rather than reading as complete', async () => {
    const { diagnostics } = await run({ breakOn: '#github' });

    expect(diagnostics.some((entry) => entry.code === 'reestablish-failed')).toBe(true);
    const abandoned = diagnostics.find((entry) => entry.code === 'actions-abandoned');
    expect(abandoned?.level).toBe('warn');
    expect(abandoned?.message).toContain('1 action');
  });

  it('works every action when it can get back, so the break is the exception', async () => {
    const { taps, diagnostics, edges } = await run({});

    // Both actions on `/login` run, in order. Later repeats are §7.4 replay,
    // re-reaching `/register` to work it in turn.
    expect(taps.slice(0, 2)).toEqual(['#github', '#signup']);
    expect(edges.some((edge) => edge.to === '/register')).toBe(true);
    expect(diagnostics.some((entry) => entry.code === 'actions-abandoned')).toBe(false);
  });
});
