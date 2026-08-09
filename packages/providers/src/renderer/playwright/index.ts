import { createHash } from 'node:crypto';
import type {
  Clickable,
  FormGroup,
  LaunchOptions,
  Overlay,
  RendererProvider,
  RendererSession,
  SessionState,
} from '@jsxray/core';
import { FREEZE_SCRIPT, WAIT_FOR_QUIET_DOM } from './freeze.js';
import { COLLECT_CLICKABLES, COLLECT_FORMS, COLLECT_OVERLAYS } from './collect.js';

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
    renderTargets: ['web'],
    sessionPersistence: true,
    determinismFreeze: true,
    elementBoxes: false,
  },

  supports: (profile) => profile.renderTarget === 'web',

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
  readonly renderTarget = 'web';
  readonly viewport: { width: number; height: number };
  readonly deviceScaleFactor: number;

  constructor(
    private readonly browser: PlaywrightBrowser,
    private readonly context: PlaywrightContext,
    private readonly page: PlaywrightPage,
    private readonly options: LaunchOptions,
    deviceScaleFactor: number,
  ) {
    this.viewport = options.viewport;
    this.deviceScaleFactor = deviceScaleFactor;
  }

  /** §8 — an init script, because it has to land before the first line of app code. */
  async freeze(): Promise<void> {
    await this.context.addInitScript({ content: FREEZE_SCRIPT });
  }

  async goto(target: string): Promise<void> {
    await this.page.goto(new URL(target, this.options.baseUrl).toString(), {
      waitUntil: 'domcontentloaded',
    });
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  /**
   * No `networkidle` here: it costs a flat 500ms on every action, and what it was
   * covering — late renders, fonts, images — is covered below at a fraction of it.
   */
  async settle(): Promise<void> {
    await this.page.waitForLoadState('load').catch(() => undefined);
    await this.page.evaluate<void>(WAIT_FOR_QUIET_DOM).catch(() => undefined);
    await this.page
      .evaluate<void>(
        `(async () => {
          window.scrollTo(0, 0);
          await document.fonts.ready;
          await Promise.all(
            [...document.images].filter((image) => !image.complete).map((image) =>
              image.decode().catch(() => undefined),
            ),
          );
          await Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
          );
        })()`,
      )
      .catch(() => undefined);
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
