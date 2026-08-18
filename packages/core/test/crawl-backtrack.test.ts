import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import type {
  NavigationMode,
  RendererProvider,
  RendererSession,
} from '../src/providers.js';
import { emptyDocument, type CrawlOutput, type JsxrayDocument } from '../src/index.js';
import { crawl } from '../src/stages/crawl.js';
import type {
  Clickable,
  FormGroup,
  Overlay,
  RenderStatus,
  SessionState,
} from '../src/runtime.js';

const BASE = 'http://localhost:9996';

const link = (
  ref: string,
  label: string,
  target: string | null,
  external = false,
): Clickable => ({
  ref,
  label,
  target,
  role: target ? 'link' : 'button',
  inOverlay: false,
  external,
});

/**
 * A feed offering the same route four times over, a nav link into a route the map
 * has not seen, and a button that opens a sheet.
 */
const FEED: Clickable[] = [
  link('#post-1', 'First post', '/post/3lmqk4rt2xc21'),
  link('#post-2', 'Second post', '/post/3lmqk4rt2xc22'),
  link('#post-3', 'Third post', '/post/3lmqk4rt2xc23'),
  link('#compose', 'Compose', null),
  link('#explore', 'Explore', '/explore'),
  link('#news', 'A news article', null, true),
  // Last in the DOM, and the only screen already on the map with no way into it.
  link('#settings', 'Settings', '/settings'),
  link('#home', 'Home', '/'),
];

/** No address, so where it goes is unknown until it is pressed — and it goes home. */
const BACK: Clickable[] = [link('#back', 'Go back', null)];

interface StubOptions {
  /** How old a screen must be before it stops looking like a skeleton. */
  readyAfterMs?: number;
  /** Pretend the screen has been on show this long already when the walk arrives. */
  bornMsAgo?: number;
}

class StubSession implements RendererSession {
  readonly rendererId = 'stub';
  readonly renderTarget = 'web' as const;
  readonly viewport = { width: 100, height: 100 };
  readonly deviceScaleFactor = 1;

  readonly taps: string[] = [];
  readonly loads: string[] = [];
  readonly moves: string[] = [];
  private current = '/';
  private sheet = false;
  private startedAt: number;

  constructor(private readonly options: StubOptions) {
    this.startedAt = Date.now() - (options.bornMsAgo ?? 0);
  }

  async freeze(): Promise<void> {}

  pageAge(): number {
    return Date.now() - this.startedAt;
  }

  async goto(target: string, mode: NavigationMode = 'load'): Promise<void> {
    const route = target.startsWith(BASE) ? target.slice(BASE.length) : target;
    if (mode === 'history') this.moves.push(route);
    else this.loads.push(route);
    this.current = route || '/';
    this.sheet = false;
  }

  async settle(): Promise<void> {}
  async url(): Promise<string> {
    return `${BASE}${this.current}`;
  }
  async fingerprint(): Promise<string> {
    return `${this.current}${this.sheet ? '+sheet' : ''}`;
  }

  /** A real screen stops being a skeleton because time passed, not because it was asked. */
  async renderStatus(): Promise<RenderStatus> {
    return this.pageAge() >= (this.options.readyAfterMs ?? 0) ? 'ok' : 'loading';
  }

  async overlays(): Promise<Overlay[]> {
    return this.sheet
      ? [{ name: 'compose', role: 'dialog', via: 'role', subtreeHash: 'h' }]
      : [];
  }
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0]);
  }
  async clickables(): Promise<Clickable[]> {
    if (this.sheet) return [link('#send', 'Send', null)];
    if (this.current === '/') return FEED;
    return this.current === '/explore' ? BACK : [];
  }
  async forms(): Promise<FormGroup[]> {
    return [];
  }

  async tap(ref: string): Promise<void> {
    this.taps.push(ref);
    if (ref === '#compose') {
      this.sheet = true;
      return;
    }
    if (ref === '#back') {
      this.current = '/';
      this.sheet = false;
      return;
    }
    const target = FEED.find((item) => item.ref === ref)?.target;
    if (target) {
      this.current = target;
      this.sheet = false;
    }
  }

  async fill(): Promise<void> {}
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

type RunResult = CrawlOutput & { taps: string[]; loads: string[]; moves: string[] };

async function run(options: StubOptions = {}, delayMs = 0): Promise<RunResult> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-backtrack-'));
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

  // `/settings` is declared by the router, so phase 2 seeds it — but it is not a
  // seed route, so it is not a root and it still needs a line drawn into it.
  const document = emptyDocument('/tmp/app', 'test');
  document.screens = [
    { id: '/settings', route: '/settings', isPage: true, meta: { groups: [] } },
  ] as JsxrayDocument['screens'];

  const output = await crawl({
    document,
    config: resolveConfig(
      {
        url: BASE,
        personas: [{ id: 'anon' }],
        seedRoutes: ['/'],
        bounds: { maxDepth: 3, maxStates: 20, actionCap: 4, timeoutMs: 20_000 },
        capture: { delayMs },
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

  return { ...output, taps: session.taps, loads: session.loads, moves: session.moves };
}

describe('getting back to a state', () => {
  it('moves through history rather than reloading the app', async () => {
    const { loads, moves } = await run();

    // The app boots once; every route change after it is a move inside that boot.
    expect(loads[0]).toBe('/');
    expect(moves.length).toBeGreaterThan(loads.length);
  });

  it('re-taps what a URL cannot restore, and reloads to clear a stale overlay', async () => {
    const { states, taps, loads } = await run();

    expect(states.map((state) => state.signature)).toContain('/$compose');
    // Twice: once to open the sheet, once to get back to it and work it.
    expect(taps.filter((ref) => ref === '#compose')).toHaveLength(2);
    // The sheet sits over `/`, so the URL alone cannot clear it.
    expect(loads.filter((route) => route === '/').length).toBeGreaterThan(1);
  });
});

describe('which actions the walk spends its budget on', () => {
  it('draws the missing line first, whatever the DOM order', async () => {
    // `/settings` was seeded, so the map holds the screen and no way into it. It is
    // last in the DOM and still goes first, because it is what the map is missing.
    const { taps } = await run();
    expect(taps[0]).toBe('#settings');
  });

  it('never spends a click arriving back at a seed', async () => {
    // `/` is where the crawl entered and where the canvas roots. A line into it
    // shows a reader nothing, so it sorts below everything that draws one.
    const { taps, states, edges } = await run();
    const feed = states.find((state) => state.signature === '/')!;

    expect(taps).not.toContain('#home');
    // Refused outright, not merely ranked last: on a quiet screen the cap never
    // binds and a last-ranked link is still pressed.
    expect(feed.untriedActions.find((action) => action.target === '/')?.reason).toBe('seed');
    expect(edges.filter((edge) => edge.to === '/' && edge.from !== '/')).toEqual([]);
  });

  it('draws no line into a root, even from a control it had to press to find out', async () => {
    // "Go back" carries no address. The only place to refuse it is after the landing.
    const { taps, edges, states } = await run();

    // It is pressed from `/explore`, where going back really does move the app.
    expect(taps).toContain('#back');
    expect(states.map((state) => state.route)).toContain('/explore');
    expect(edges.filter((edge) => edge.to === '/')).toEqual([]);
  });

  it('never presses a link that leaves the app, and says it did not', async () => {
    const { taps, states } = await run();
    const feed = states.find((state) => state.signature === '/')!;

    expect(taps).not.toContain('#news');
    expect(
      feed.untriedActions.filter((action) => action.reason === 'external').map((a) => a.label),
    ).toEqual(['A news article']);
  });

  it('presses one post, not every post, and says why the rest went untried', async () => {
    const { states, taps, edges } = await run();
    const feed = states.find((state) => state.signature === '/')!;

    expect(taps.filter((ref) => ref.startsWith('#post-'))).toEqual(['#post-1']);
    expect(edges.filter((edge) => edge.to === '/post/:id')).toHaveLength(1);
    expect(
      feed.untriedActions.filter((action) => action.reason === 'known-target').map((a) => a.target),
    ).toEqual(['/post/3lmqk4rt2xc22', '/post/3lmqk4rt2xc23']);
  });

  it('spends the action cap on screens, not on repeats or on the way home', async () => {
    // Eight controls collapse to four once the repeats, the off-site link and the
    // named way home are gone — so the cap of four is never reached.
    const { states } = await run();
    const feed = states.find((state) => state.signature === '/')!;

    expect(feed.untriedActions.filter((action) => action.reason === 'cap')).toEqual([]);
    expect(feed.deadActions).toEqual([]);
  });
});

describe('what a capture is a picture of', () => {
  it('waits out the floor, so the shot is of the screen and not of its skeleton', async () => {
    // Ready at 200ms, floor at 400ms: the shot lands after the screen arrives.
    const { states } = await run({ readyAfterMs: 200 }, 400);
    expect(states.every((state) => state.captureStatus === 'ok')).toBe(true);
  });

  it('waits for nothing when the screen is already older than the floor', async () => {
    // `settle()` can take longer than the floor on a cold app; the floor is an age,
    // not a sleep, so a screen that has been up for a second is shot at once.
    const started = Date.now();
    await run({ bornMsAgo: 1000 }, 400);
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('captures a screen that never arrives, and says that is what it is', async () => {
    const { states, diagnostics } = await run({ readyAfterMs: 60_000 }, 10);
    expect(states[0]?.captureStatus).toBe('loading');
    expect(states[0]?.capture).not.toBeNull();
    expect(diagnostics.some((entry) => entry.code === 'loading-capture')).toBe(true);
  });
});
