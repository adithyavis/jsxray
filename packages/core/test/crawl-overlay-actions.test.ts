import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import type { RendererProvider, RendererSession } from '../src/providers.js';
import { emptyDocument, type CrawlOutput } from '../src/index.js';
import { crawl } from '../src/stages/crawl.js';
import type { Clickable, FormGroup, Overlay, SessionState } from '../src/runtime.js';

const BASE = 'http://localhost:9997';

const NAV: Clickable[] = [
  { ref: '#home', label: 'Home', target: '/', role: 'link', inOverlay: false },
  { ref: '#explore', label: 'Explore', target: '/explore', role: 'link', inOverlay: false },
];

const INSIDE: Clickable[] = [
  { ref: '#confirm', label: 'Confirm', target: '/done', role: 'button', inOverlay: true },
];

interface StubOptions {
  /** §3.1 — an overlay found by its inert background names nothing inside itself. */
  markInside?: boolean;
}

/** `/settings` opens a dialog, and its backdrop is over the nav bar behind it. */
class StubSession implements RendererSession {
  readonly rendererId = 'stub';
  readonly renderTarget = 'web' as const;
  readonly viewport = { width: 100, height: 100 };
  readonly deviceScaleFactor = 1;

  readonly taps: string[] = [];
  /** Clicks the backdrop caught — each one a 2.5s timeout in the real renderer. */
  readonly blocked: string[] = [];
  private current = '/settings';
  private open = false;

  constructor(private readonly options: StubOptions) {}

  async freeze(): Promise<void> {}
  async goto(target: string): Promise<void> {
    this.current = target;
    this.open = false;
  }
  async settle(): Promise<void> {}
  async url(): Promise<string> {
    return `${BASE}${this.current}`;
  }
  async fingerprint(): Promise<string> {
    return `${this.current}${this.open ? '-open' : ''}`;
  }
  async hasContent(): Promise<boolean> {
    return true;
  }
  async overlays(): Promise<Overlay[]> {
    return this.open
      ? [{ name: 'rename', role: 'dialog', via: 'role', subtreeHash: 'h' }]
      : [];
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0]);
  }
  async clickables(): Promise<Clickable[]> {
    if (this.open) {
      return [
        ...NAV,
        ...INSIDE.map((item) => ({ ...item, inOverlay: this.options.markInside !== false })),
      ];
    }
    if (this.current !== '/settings') return [];
    return [
      ...NAV,
      { ref: '#rename', label: 'Rename', target: null, role: 'button', inOverlay: false },
    ];
  }
  async forms(): Promise<FormGroup[]> {
    return [];
  }

  async tap(ref: string): Promise<void> {
    this.taps.push(ref);
    if (ref === '#rename') {
      this.open = true;
      return;
    }
    // The backdrop swallows anything behind the dialog, exactly as Playwright reports it.
    if (this.open && !INSIDE.some((item) => item.ref === ref)) {
      this.blocked.push(ref);
      throw new Error(
        'locator.click: Timeout 2500ms exceeded. <div> subtree intercepts pointer events',
      );
    }
    const target = [...NAV, ...INSIDE].find((item) => item.ref === ref)?.target;
    if (target) {
      this.current = target;
      this.open = false;
    }
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

type RunResult = CrawlOutput & { taps: string[]; blocked: string[] };

async function run(options: StubOptions = {}): Promise<RunResult> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-overlay-'));
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
        seedRoutes: ['/settings'],
        bounds: { maxDepth: 3, maxStates: 20, actionCap: 8, timeoutMs: 10_000 },
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

  return { ...output, taps: session.taps, blocked: session.blocked };
}

describe('a state with a dialog open', () => {
  it('works the dialog, not the page its backdrop covers', async () => {
    const { taps, blocked, edges } = await run();

    expect(taps).toContain('#rename');
    expect(taps).toContain('#confirm');
    // The nav bar sits behind the backdrop, so not one click is aimed at it.
    expect(blocked).toEqual([]);
    expect(edges.some((edge) => edge.to === '/done')).toBe(true);
  });

  it('reports no blocked action, because none is attempted', async () => {
    const { diagnostics } = await run();
    expect(diagnostics.filter((entry) => entry.code === 'action-failed')).toHaveLength(0);
  });

  it('still works an overlay whose contents it cannot name as inside it', async () => {
    const { taps } = await run({ markInside: false });
    expect(taps).toContain('#confirm');
  });
});
