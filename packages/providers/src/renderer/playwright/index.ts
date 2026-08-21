import { createHash } from 'node:crypto';
import {
  INTERCEPTED_TAG,
  type Clickable,
  type RenderTarget,
  type FormGroup,
  type LaunchOptions,
  type NavigationMode,
  type Overlay,
  type RendererProvider,
  type RendererSession,
  type RenderStatus,
  type SessionState,
} from '@jsxray/core';
import { AWAIT_PAINT, freezeScript, waitForQuietDom } from './freeze.js';
import { CLASSIFY_RENDER, COLLECT_CLICKABLES, COLLECT_FORMS, COLLECT_OVERLAYS } from './collect.js';

const WAIT_FOR_QUIET_DOM = waitForQuietDom(CLASSIFY_RENDER);

interface PlaywrightModule {
  chromium: {
    launch(options: {
      headless: boolean;
      channel?: string;
    }): Promise<PlaywrightBrowser>;
  };
}

interface PlaywrightBrowser {
  newContext(options: unknown): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  addInitScript(script: { content: string }): Promise<void>;
  storageState(): Promise<unknown>;
  addCookies(cookies: unknown[]): Promise<void>;
}

/** Halved, so a blocked click plus its retry costs what one click cost before. */
const TAP_TIMEOUT = 2_500;
const PARK_MS = 200;
const INTERCEPTED = /intercepts pointer events/;

interface PlaywrightPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  mouse: { move(x: number, y: number): Promise<void> };
  url(): string;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  screenshot(options?: unknown): Promise<Uint8Array>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  locator(selector: string): PlaywrightLocator;
  setDefaultTimeout(ms: number): void;
  addStyleTag(options: { content: string }): Promise<unknown>;
}

interface PlaywrightLocator {
  first(): PlaywrightLocator;
  click(options?: unknown): Promise<void>;
  fill(value: string, options?: unknown): Promise<void>;
  selectOption(value: string, options?: unknown): Promise<unknown>;
  check(options?: unknown): Promise<void>;
  ariaSnapshot(options?: unknown): Promise<string>;
  count(): Promise<number>;
  evaluate<T>(fn: (element: DomElement) => T): Promise<T>;
}

/** Structural, because this package has no DOM lib. */
interface DomElement {
  tagName: string;
  getAttribute(name: string): string | null;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return (await import('playwright')) as unknown as PlaywrightModule;
  } catch {
    throw new Error(
      'The playwright renderer needs the optional peer dependency.\n' +
        '  npm install -D playwright && npx playwright install chromium',
    );
  }
}

export const playwrightRenderer: RendererProvider = {
  axis: 'renderer',
  id: 'playwright',
  priority: 10,
  capabilities: {
    // §4.4 — an Expo app runs in a browser through React Native Web, so a phone
    // viewport here is a real map today. The capture records that it came from a
    // browser rather than a device, which is what keeps the shortcut honest.
    renderTargets: ['web', 'native'],
    sessionPersistence: true,
    determinismFreeze: true,
    elementBoxes: false,
  },

  supports: (profile) => profile.renderTarget === 'web' || profile.renderTarget === 'native',

  async launch(options: LaunchOptions): Promise<RendererSession> {
    const { chromium } = await loadPlaywright();
    const browser = await chromium.launch({
      headless: !options.headed,
      ...(options.channel ? { channel: options.channel } : {}),
    });
    const deviceScaleFactor = options.deviceScaleFactor ?? 1;
    const context = await browser.newContext({
      viewport: options.viewport,
      deviceScaleFactor,
      reducedMotion: 'reduce',
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(options.timeoutMs, 30_000));

    return new PlaywrightSession(browser, context, page, options, deviceScaleFactor);
  },
};

class PlaywrightSession implements RendererSession {
  readonly rendererId = 'playwright';
  readonly renderTarget: RenderTarget;
  /** Mutable, because `resize` moves the page to another viewport (§7.8). */
  viewport: { width: number; height: number };
  readonly deviceScaleFactor: number;
  private historyRefusals = 0;
  private historyAnswered = false;
  /** §7.10 — when the screen now on show began arriving. */
  private screenStartedAt = Date.now();

  constructor(
    private readonly browser: PlaywrightBrowser,
    private readonly context: PlaywrightContext,
    private readonly page: PlaywrightPage,
    private readonly options: LaunchOptions,
    deviceScaleFactor: number,
  ) {
    this.renderTarget = options.renderTarget;
    this.viewport = options.viewport;
    this.deviceScaleFactor = deviceScaleFactor;
  }

  /** §8 — an init script, because it has to land before the first line of app code. */
  async freeze(): Promise<void> {
    await this.context.addInitScript({ content: freezeScript(this.options.clockMs) });
  }

  pageAge(): number {
    return Date.now() - this.screenStartedAt;
  }

  /** Returns once the page has settled, so no caller settles a second time. */
  async goto(target: string, mode: NavigationMode = 'load'): Promise<void> {
    this.screenStartedAt = Date.now();
    const url = new URL(target, this.options.baseUrl).toString();
    if (mode === 'history' && (await this.moveByHistory(url))) return;
    await navigate(this.page, url);
    await this.settle();
  }

  /**
   * §7.4 — push the entry and let the router hear it, so the app keeps the boot it
   * already paid for. A router that ignores `popstate` leaves the page as it was,
   * and an unchanged fingerprint is how that is caught; the caller then loads.
   *
   * An app with no client router answers that way every time, and each attempt
   * costs a settle for nothing. Two refusals in a row is enough: stop asking.
   *
   * Only of an app that has never answered. Once one move has landed the router is
   * there, and a refusal after that is about the screen in front of it — a crash
   * boundary, a screen still arriving — so the rest of the run keeps its in-app moves.
   */
  private async moveByHistory(url: string): Promise<boolean> {
    if (!worthProbingHistory(this.historyAnswered, this.historyRefusals)) return false;
    if (!this.page.url().startsWith(new URL(this.options.baseUrl).origin)) return false;
    const before = await this.fingerprint();
    const moved = await this.page.evaluate<boolean>(historyGoto(url)).catch(() => false);
    if (moved) {
      await this.settle();
      if ((await this.fingerprint()) !== before) {
        this.historyAnswered = true;
        this.historyRefusals = 0;
        return true;
      }
    }
    this.historyRefusals++;
    return false;
  }

  /**
   * No `networkidle` here. It waits on the network, which a live app never lets go
   * quiet, so it ran to its cap every time. This waits on the screen, which does
   * arrive — and returns the moment it has.
   */
  async settle(): Promise<void> {
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.page.evaluate<void>(WAIT_FOR_QUIET_DOM).catch(() => undefined);
  }

  async url(): Promise<string> {
    return this.page.url();
  }

  /** A broad digest over the accessibility tree — portable to a native renderer (§4.2). */
  async fingerprint(): Promise<string> {
    const snapshot = await this.page
      .locator('body')
      .first()
      .ariaSnapshot()
      .catch(() => '');
    return hash(snapshot);
  }

  /** On failure, assume the screen is there — a lost capture is the worse loss. */
  async renderStatus(): Promise<RenderStatus> {
    return this.page.evaluate<RenderStatus>(CLASSIFY_RENDER).catch(() => 'ok' as const);
  }

  async overlays(): Promise<Overlay[]> {
    return this.page.evaluate<Overlay[]>(COLLECT_OVERLAYS).catch(() => []);
  }

  async screenshot(): Promise<Uint8Array> {
    await this.page.evaluate<void>(AWAIT_PAINT).catch(() => undefined);
    return this.page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  }

  /**
   * §7.8 — the app re-lays itself out on a resize, and a responsive one swaps whole
   * regions doing it, so the page is settled again before anything reads it.
   */
  async resize(viewport: { width: number; height: number }): Promise<void> {
    if (viewport.width === this.viewport.width && viewport.height === this.viewport.height) return;
    await this.page.setViewportSize(viewport);
    this.viewport = viewport;
    await this.settle();
  }

  async clickables(): Promise<Clickable[]> {
    return this.page.evaluate<Clickable[]>(COLLECT_CLICKABLES).catch(() => []);
  }

  async forms(): Promise<FormGroup[]> {
    return this.page.evaluate<FormGroup[]>(COLLECT_FORMS).catch(() => []);
  }

  /**
   * Playwright's own auto-wait, deliberately kept: a control that has not rendered
   * yet is not a control that is gone. A flow's submit button appears a beat after
   * the form it belongs to, and refusing it on the first look breaks every login.
   * The crawl's own stale-ref check lives in the walk (§7.11), which asks the page
   * what is on it before it presses anything.
   */
  async tap(ref: string): Promise<void> {
    // A press is how most screens start arriving, so the clock starts here too.
    this.screenStartedAt = Date.now();
    await click(this.page, this.page.locator(ref).first(), this.viewport);
  }

  async fill(ref: string, value: string): Promise<void> {
    const locator = this.page.locator(ref).first();
    const kind = await locator.evaluate<string>((element) =>
      element.tagName.toLowerCase() === 'select'
        ? 'select'
        : (element.getAttribute('type') ?? 'text'),
    );
    if (kind === 'select') {
      await locator.selectOption(value, { timeout: 5_000 });
      return;
    }
    if (kind === 'checkbox' || kind === 'radio') {
      await locator.check({ timeout: 5_000 });
      return;
    }
    await locator.fill(value, { timeout: 5_000 });
  }

  async session(): Promise<SessionState> {
    return this.context.storageState();
  }

  async restore(state: SessionState): Promise<void> {
    const cookies = (state as { cookies?: unknown[] } | null)?.cookies;
    if (Array.isArray(cookies)) await this.context.addCookies(cookies);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/**
 * §7.4 — the same move the app's own links make. `popstate` is what every router
 * listens to, and dispatching it is the only way to announce a `pushState` the
 * router did not make itself.
 */
/** §7.4 — two tries to prove a router, then unlimited once it has proved one. */
export function worthProbingHistory(answered: boolean, refusals: number): boolean {
  return answered || refusals < 2;
}

function historyGoto(url: string): string {
  return `(() => {
  const target = new URL(${JSON.stringify(url)}, location.href);
  if (target.origin !== location.origin) return false;
  history.pushState(history.state, '', target.href);
  dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  return true;
})()`;
}

/** The part of a page a navigation needs — narrow, so a test can stand one up. */
export interface Navigable {
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
}

/**
 * No `networkidle`: a live app never goes quiet, so the wait ran to its cap on
 * every load and bought nothing `settle()` does not already cover — the load
 * event, a quiet DOM, the fonts and the images.
 */
export async function navigate(page: Navigable, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!isAbortedNavigation(error)) throw error;
    await page.waitForLoadState('load').catch(() => undefined);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

export interface Pointer {
  mouse: { move(x: number, y: number): Promise<void> };
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
}

export interface ClickTarget {
  click(options?: unknown): Promise<void>;
}

/**
 * §7.3 — a click leaves the pointer parked on what it hit, and an app that opens a
 * hover card there covers the next control with it. So park the pointer in the corner
 * first, and read an interception as one more reason to park rather than a dead action.
 */
export async function click(
  page: Pointer,
  target: ClickTarget,
  viewport: { width: number; height: number },
): Promise<void> {
  const park = async (): Promise<void> => {
    await page.mouse.move(viewport.width - 1, viewport.height - 1);
    // A hover card closes on its own delay, so give it one before pressing.
    await page.evaluate<void>(`new Promise((resolve) => setTimeout(resolve, ${PARK_MS}))`);
  };

  await park();
  try {
    await target.click({ timeout: TAP_TIMEOUT });
  } catch (error) {
    if (!INTERCEPTED.test(messageOf(error))) throw error;
    await park();
    try {
      await target.click({ timeout: TAP_TIMEOUT });
    } catch (retried) {
      if (!INTERCEPTED.test(messageOf(retried))) throw retried;
      // §7.11 — tagged, so a press the page never received reads as that and not
      // as a control that did nothing.
      throw new Error(`${INTERCEPTED_TAG} ${messageOf(retried)}`);
    }
  }
}

/** Chromium's name for "someone else navigated first" — a race, not a dead page. */
function isAbortedNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('net::ERR_ABORTED');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
