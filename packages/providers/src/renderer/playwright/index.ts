import { createHash } from 'node:crypto';
import type {
  Clickable,
  RenderTarget,
  FormGroup,
  LaunchOptions,
  Overlay,
  RendererProvider,
  RendererSession,
  SessionState,
} from '@jsxray/core';
import { FREEZE_SCRIPT, SETTLE_PAGE, WAIT_FOR_QUIET_DOM } from './freeze.js';
import {
  COLLECT_CLICKABLES,
  COLLECT_FORMS,
  COLLECT_OVERLAYS,
  PAINTS_SOMETHING,
} from './collect.js';

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

interface PlaywrightPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  url(): string;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  screenshot(options?: unknown): Promise<Uint8Array>;
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
  readonly viewport: { width: number; height: number };
  readonly deviceScaleFactor: number;

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
    await this.context.addInitScript({ content: FREEZE_SCRIPT });
  }

  async goto(target: string): Promise<void> {
    await navigate(this.page, new URL(target, this.options.baseUrl).toString());
  }

  /**
   * No `networkidle` here: it costs a flat 500ms on every action, and what it was
   * covering — late renders, fonts, images — is covered below at a fraction of it.
   */
  async settle(): Promise<void> {
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.page.evaluate<void>(WAIT_FOR_QUIET_DOM).catch(() => undefined);
    await this.page.evaluate<void>(SETTLE_PAGE).catch(() => undefined);
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

  /** On failure, assume there is something to see — a lost capture is the worse loss. */
  async hasContent(): Promise<boolean> {
    return this.page.evaluate<boolean>(PAINTS_SOMETHING).catch(() => true);
  }

  async overlays(): Promise<Overlay[]> {
    return this.page.evaluate<Overlay[]>(COLLECT_OVERLAYS).catch(() => []);
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  }

  async clickables(): Promise<Clickable[]> {
    return this.page.evaluate<Clickable[]>(COLLECT_CLICKABLES).catch(() => []);
  }

  async forms(): Promise<FormGroup[]> {
    return this.page.evaluate<FormGroup[]>(COLLECT_FORMS).catch(() => []);
  }

  async tap(ref: string): Promise<void> {
    await this.page.locator(ref).first().click({ timeout: 5_000 });
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

/** The part of a page a navigation needs — narrow, so a test can stand one up. */
export interface Navigable {
  goto(url: string, options?: unknown): Promise<unknown>;
  waitForLoadState(state: string, options?: unknown): Promise<void>;
}

export async function navigate(page: Navigable, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!isAbortedNavigation(error)) throw error;
    await page.waitForLoadState('load').catch(() => undefined);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
}

/** Chromium's name for "someone else navigated first" — a race, not a dead page. */
function isAbortedNavigation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('net::ERR_ABORTED');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
