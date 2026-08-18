import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_DIRNAME,
  resolveCredentials,
  type FlowStep,
  type PersonaConfig,
  type ResolvedConfig,
} from '../config.js';
import { planForm } from '../forms.js';
import { createGuard, type SafetyGuard } from '../guard.js';
import { documentRelative, slugForFile, slugify } from '../paths.js';
import type { AuthProvider, RendererProvider, RendererSession } from '../providers.js';
import {
  canonicalizeUrl,
  edgeMatchKey,
  inferRoutePatterns,
  isDynamic,
  screenOfStateSignature,
  stateSignature,
  stripUrl,
} from '../route.js';
import {
  isIntercepted,
  isStaleRef,
  STALE_REF_TAG,
  type Clickable,
  type FormGroup,
  type Overlay,
} from '../runtime.js';
import type {
  Diagnostic,
  Edge,
  JsxrayDocument,
  OverlayRef,
  ScreenState,
  Step,
  UntriedReason,
} from '../schema.js';

export interface CrawlInput {
  document: JsxrayDocument;
  config: ResolvedConfig;
  renderer: RendererProvider;
  auth: AuthProvider | null;
  outDir: string;
  baseUrl: string;
  headed: boolean;
  personaIds: string[] | null;
  log(message: string): void;
}

export interface CrawlOutput {
  states: ScreenState[];
  edges: Edge[];
  diagnostics: Diagnostic[];
}

interface Observation {
  url: string;
  route: string;
  signature: string;
  overlays: OverlayRef[];
  fingerprint: string;
  /** §13 — a route handler renders no UI, so landing on one is not reaching a screen. */
  routeHandler: boolean;
}

export async function crawl(input: CrawlInput): Promise<CrawlOutput> {
  const { document, config, renderer, auth, log } = input;
  const guard = createGuard(config.ignore);
  const diagnostics: Diagnostic[] = [];
  const states: ScreenState[] = [];
  const edges: Edge[] = [];

  const patterns = document.screens.filter((screen) => screen.isPage).map((screen) => screen.route);
  const screenIdByRoute = new Map(
    document.screens.filter((screen) => screen.isPage).map((screen) => [screen.route, screen.id]),
  );

  const handlerRoutes = new Set(
    document.screens
      .filter((screen) => screen.kind === 'route-handler')
      .map((screen) => screen.route),
  );
  for (const route of patterns) handlerRoutes.delete(route);
  const matchPatterns = unique([...patterns, ...handlerRoutes]);
  const personas = config.personas.filter(
    (persona) => !input.personaIds || input.personaIds.includes(persona.id),
  );

  // §8 — one clock for the whole run, so personas stay diffable against each other.
  const clockMs = config.clock ?? Date.now();

  for (const persona of personas) {
    clearCaptures(input.outDir, persona.id);
    const walker = new PersonaCrawl({
      persona,
      config,
      guard,
      patterns,
      matchPatterns,
      handlerRoutes,
      screenIdByRoute,
      outDir: input.outDir,
      diagnostics,
      states,
      edges,
      log,
    });

    let session: RendererSession | null = null;
    try {
      session = await renderer.launch({
        baseUrl: input.baseUrl,
        renderTarget: config.renderTarget,
        headed: input.headed,
        viewport: config.viewport,
        timeoutMs: config.bounds.timeoutMs,
        clockMs,
        channel: config.channel,
      });

      // §4.4 — a phone-viewport browser shot of an Expo app is a legitimate
      // artifact; presenting it as a device capture without saying so is not.
      if (config.renderTarget === 'native' && renderer.id === 'playwright') {
        diagnostics.push({
          level: 'info',
          stage: 'crawl',
          code: 'native-in-browser',
          message: `renderTarget is "native" but captures come from a browser at ${config.viewport.width}×${config.viewport.height}, not from a device`,
        });
      }

      // §7 — freeze before login: login is app code, and an SPA boots once.
      if (renderer.capabilities.determinismFreeze) {
        await session.freeze();
      } else {
        diagnostics.push({
          level: 'warn',
          stage: 'crawl',
          code: 'no-determinism-freeze',
          message: `renderer "${renderer.id}" cannot freeze; this run is not reproducible`,
        });
      }

      const credentials = resolveCredentials(persona);
      if (credentials) {
        if (!auth) {
          diagnostics.push({
            level: 'error',
            stage: 'crawl',
            code: 'no-auth-provider',
            message: `persona "${persona.id}" declares a login but no auth provider applies; skipped rather than crawled logged-out`,
          });
          continue;
        }
        await auth.login(session, credentials, config.loginFlow);
        await session.settle();
      }

      await walker.run(session, auth, Boolean(credentials));
    } catch (error) {
      diagnostics.push({
        level: 'error',
        stage: 'crawl',
        code: 'persona-failed',
        message: `persona "${persona.id}": ${messageOf(error)}`,
      });
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  mergeInferredRoutes({ states, edges, diagnostics, matchPatterns, screenIdByRoute, outDir: input.outDir });
  return { states, edges, diagnostics };
}

function mergeInferredRoutes(input: {
  states: ScreenState[];
  edges: Edge[];
  diagnostics: Diagnostic[];
  matchPatterns: string[];
  screenIdByRoute: Map<string, string>;
  outDir: string;
}): void {
  const learned = inferRoutePatterns(input.states.map((state) => state.url));
  if (!learned.length) return;

  const patterns = unique([...input.matchPatterns, ...learned]);
  const rename = new Map<string, string>();
  const kept: ScreenState[] = [];
  const dropped: ScreenState[] = [];

  for (const state of input.states) {
    const route = canonicalizeUrl(state.url, patterns);
    const screenId = input.screenIdByRoute.get(route) ?? route;
    const signature = stateSignature(
      screenId,
      state.overlays.map((overlay) => overlay.name),
    );
    rename.set(state.signature, signature);

    const existing = kept.find(
      (candidate) => candidate.signature === signature && candidate.personaId === state.personaId,
    );
    if (existing) {
      dropped.push(state);
      continue;
    }
    state.route = route;
    state.screenId = screenId;
    state.signature = signature;
    kept.push(state);
  }

  if (!dropped.length) return;

  for (const state of dropped) {
    if (!state.capture) continue;
    try {
      fs.rmSync(path.join(input.outDir, state.capture.path), { force: true });
    } catch {
      /* an orphaned capture is untidy, not fatal */
    }
  }

  const remap = (signature: string | undefined): string | undefined =>
    signature === undefined ? undefined : (rename.get(signature) ?? signature);

  for (const edge of input.edges) {
    if (edge.discoveredBy !== 'runtime') continue;
    edge.fromState = remap(edge.fromState);
    edge.toState = remap(edge.toState);
    edge.from = screenOfStateSignature(edge.fromState ?? edge.from);
    edge.to = edge.toState ? screenOfStateSignature(edge.toState) : edge.to;
    edge.matchKey = edgeMatchKey(edge.from, edge.to);
  }

  input.states.length = 0;
  input.states.push(...kept);
  input.edges.splice(
    0,
    input.edges.length,
    ...input.edges.filter(
      (edge, index, all) => all.findIndex((other) => other.id === edge.id) === index,
    ),
  );

  input.diagnostics.push({
    level: 'info',
    stage: 'crawl',
    code: 'merged-inferred-routes',
    message: `${dropped.length} states folded into inferred patterns: ${learned.join(', ')}`,
  });
}

interface PersonaCrawlInput {
  persona: PersonaConfig;
  config: ResolvedConfig;
  guard: SafetyGuard;
  /** Page routes — what the crawl seeds and what it may come to rest on. */
  patterns: string[];
  /** Every declared route, page or not — what a URL is canonicalized against. */
  matchPatterns: string[];
  handlerRoutes: Set<string>;
  screenIdByRoute: Map<string, string>;
  outDir: string;
  diagnostics: Diagnostic[];
  states: ScreenState[];
  edges: Edge[];
  log(message: string): void;
}

/**
 * Timing trace, off unless `JSXRAY_TRACE=1`. It writes to stderr, so it never
 * touches the document — see [performance.md](../../../../specs/performance.md).
 */
const TRACE = Boolean(process.env.JSXRAY_TRACE);
const TRACE_START = Date.now();

function trace(message: string): void {
  if (!TRACE) return;
  const at = ((Date.now() - TRACE_START) / 1000).toFixed(1).padStart(7);
  process.stderr.write(`[trace ${at}s] ${message}\n`);
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!TRACE) return run();
  const at = Date.now();
  try {
    return await run();
  } finally {
    trace(`${label} — ${Date.now() - at}ms`);
  }
}

class PersonaCrawl {
  private readonly visited = new Set<string>();
  private readonly frontier: ScreenState[] = [];
  /** §7.4 — per state signature, the steps its URL alone cannot restore. */
  private readonly restoreTail = new Map<string, Step[]>();
  /** Concrete paths seen so far, and the patterns inferred from them (§3). */
  private readonly observedPaths: string[] = [];
  private learned: string[] = [];
  private readonly deadline: number;
  private stateBudget: number;

  constructor(private readonly input: PersonaCrawlInput) {
    this.deadline = Date.now() + input.config.bounds.timeoutMs;
    // §8 — null is "no ceiling"; the deadline is then the only stop.
    this.stateBudget = input.config.bounds.maxStates ?? Number.POSITIVE_INFINITY;
  }

  async run(session: RendererSession, auth: AuthProvider | null, authenticated: boolean) {
    trace(`persona ${this.input.persona.id}: flows`);
    await this.runFlows(session);
    trace(`persona ${this.input.persona.id}: seeds`);
    await this.runSeeds(session);
    trace(`persona ${this.input.persona.id}: walk, frontier ${this.frontier.length}`);
    await this.runWalk(session, auth, authenticated);
    trace(`persona ${this.input.persona.id}: done, ${this.input.states.length} states`);
  }

  /** Phase 1 — named flows reach gated states reliably. */
  private async runFlows(session: RendererSession) {
    const { config, persona } = this.input;
    const applicable = config.flows.filter(
      (flow) => !flow.personas || flow.personas.includes(persona.id),
    );

    for (const flow of applicable) {
      const steps: Step[] = [];
      try {
        if (flow.start) {
          await session.goto(flow.start);
          steps.push({ kind: 'goto', target: flow.start });
        }
        let previous = await this.observe(session);
        if (this.discardHandlerLanding(previous, `flow "${flow.id}"`)) continue;
        let previousState = await this.record(session, previous, [...steps], 0, 'free');

        for (const step of flow.steps) {
          const recorded = await this.perform(session, step);
          steps.push(...recorded);
          const next = await this.observe(session);
          if (this.discardHandlerLanding(next, `flow "${flow.id}"`)) break;
          if (next.signature === previous.signature) continue;
          const nextState = await this.record(
            session,
            next,
            [...steps],
            previousState.depth + 1,
            'free',
            this.tailFor(previousState, previous, next, recorded),
          );
          this.addEdge(previousState, nextState, labelOfStep(step), 'action');
          previous = next;
          previousState = nextState;
        }
      } catch (error) {
        this.input.diagnostics.push({
          level: 'warn',
          stage: 'crawl',
          code: 'flow-failed',
          message: `flow "${flow.id}" for persona "${persona.id}": ${messageOf(error)}`,
        });
      }
    }
  }

  /** Phase 2 — seeds: config.seedRoutes ∪ declared page routes. */
  private async runSeeds(session: RendererSession) {
    const { config, guard, patterns, diagnostics } = this.input;
    const declared = patterns.filter((route) => !isDynamic(route));
    const skipped = patterns.filter((route) => isDynamic(route));

    for (const route of skipped) {
      diagnostics.push({
        level: 'info',
        stage: 'crawl',
        code: 'dynamic-route-unseeded',
        message: `${route} needs a concrete param; reachable only from a link or a flow (§13)`,
      });
    }

    let booted = false;
    for (const route of unique([...config.seedRoutes, ...declared])) {
      if (guard.blocksNavigation(route)) continue;
      if (!this.beforeDeadline()) return;
      try {
        // §7.4 — the app boots once; every seed after that is a move inside it.
        await timed(`seed goto ${route}`, () => session.goto(route, booted ? 'history' : 'load'));
        booted = true;
        const observation = await timed(`seed observe ${route}`, () => this.observe(session));
        if (this.discardHandlerLanding(observation, route)) continue;
        if (this.visited.has(observation.signature)) continue;
        await timed(`seed record ${route}`, () =>
          this.record(session, observation, [{ kind: 'goto', target: route }], 0, 'free'),
        );
      } catch (error) {
        diagnostics.push({
          level: 'warn',
          stage: 'crawl',
          code: 'seed-failed',
          message: `${route}: ${messageOf(error)}`,
        });
      }
    }
  }

  /** Phase 3 — bounded interaction walk. */
  private async runWalk(
    session: RendererSession,
    auth: AuthProvider | null,
    authenticated: boolean,
  ) {
    const { config, guard, diagnostics, persona } = this.input;

    while (this.frontier.length) {
      if (!this.hasBudget()) {
        diagnostics.push({
          level: 'warn',
          stage: 'crawl',
          code: 'budget-exhausted',
          message: `persona "${persona.id}": stopped with ${this.frontier.length} states unexplored`,
        });
        return;
      }

      const state = this.frontier.shift()!;
      trace(
        `state ${state.signature} depth=${state.depth} steps=${state.reachedVia.length} ` +
          `frontier=${this.frontier.length} budget=${this.stateBudget} states=${this.input.states.length}`,
      );
      if (state.depth >= config.bounds.maxDepth) continue;
      if (guard.blocksActions(state.route)) continue;

      if (authenticated && auth?.isLoggedIn) {
        if (!(await auth.isLoggedIn(session))) {
          const credentials = resolveCredentials(persona);
          if (credentials) await auth.login(session, credentials, config.loginFlow);
        }
      }

      if (
        !(await timed(`  reEstablish ${state.signature}`, () => this.reEstablish(session, state)))
      )
        continue;

      const collected = await timed(`  collect ${state.signature}`, async () => {
        const found = [...(await session.clickables()), ...(await session.forms())];
        const reachable = actionsWithinOverlay(
          state,
          this.safeActions(state, this.inApp(state, found)),
        );
        // Rank before deduping, so the best link to a screen is the one kept: a nav
        // item beats a post in the feed that happens to share its destination.
        return this.oneLinkPerScreen(state, this.byWhatTheyTeach(reachable));
      });
      const actions = collected.slice(0, config.bounds.actionCap);
      for (const cut of collected.slice(config.bounds.actionCap)) this.noteUntried(state, cut, 'cap');
      trace(`  ${actions.length} actions on ${state.signature} (${collected.length} collected)`);

      for (const [index, action] of actions.entries()) {
        if (!this.hasBudget()) {
          for (const rest of actions.slice(index)) this.noteUntried(state, rest, 'budget');
          return;
        }
        if ('target' in action && guard.blocksNavigation(action.target)) {
          this.noteUntried(state, action, 'ignored');
          continue;
        }
        if ('target' in action && this.targetsRouteHandler(action.target)) {
          diagnostics.push({
            level: 'info',
            stage: 'crawl',
            code: 'route-handler-landing',
            message: `${labelOf(action) ?? action.ref} points at ${action.target}, a route handler; not followed`,
          });
          this.noteUntried(state, action, 'ignored');
          continue;
        }
        // The map already has this line, so pressing it again costs a full cycle
        // and draws nothing new — the fiftieth post in a feed is the first one.
        if ('target' in action && this.alreadyDrawn(state, action.target)) {
          this.noteUntried(state, action, 'known-target');
          continue;
        }

        const label = labelOf(action) ?? action.ref;
        const before = await timed(`    observe before "${label}"`, () => this.observe(session));
        const performed = await timed(`    act "${label}"`, () => this.attempt(session, action));
        if (!performed.length) {
          trace(`    "${label}" failed`);
          if (
            !(await timed(`    resume after "${label}"`, () =>
              this.resume(session, state, actions, index),
            ))
          )
            break;
          continue;
        }

        let after = await timed(`    observe after "${label}"`, () => this.observe(session));
        if (unchanged(before, after) && mayStillNavigate(action, before.route)) {
          // Confirm before scoring it dead: a transition may not have committed yet.
          await session.settle();
          after = await this.observe(session);
        }
        if (unchanged(before, after)) {
          trace(`    "${label}" dead`);
          this.recordDeadAction(state, action);
          continue;
        }

        if (this.discardHandlerLanding(after, labelOf(action) ?? action.ref)) {
          if (!(await this.resume(session, state, actions, index))) break;
          continue;
        }

        // A redirect can land the crawl on a banned route (§9).
        if (guard.blocksNavigation(after.route)) {
          diagnostics.push({
            level: 'info',
            stage: 'crawl',
            code: 'ignored-landing',
            message: `${labelOf(action)} redirected to ${after.route}, which ignore.navigation covers; discarded`,
          });
          if (!(await this.resume(session, state, actions, index))) break;
          continue;
        }

        const steps = [...state.reachedVia, ...performed];
        const known = this.visited.has(after.signature);
        const next = await timed(`    record ${after.signature}`, () =>
          this.record(session, after, steps, state.depth + 1, 'budget', this.tailFor(state, before, after, performed)),
        );
        trace(`    "${label}" -> ${after.signature}${known ? ' (known)' : ' (NEW)'}`);
        this.addEdge(state, next, labelOf(action), 'form' in action ? 'form' : 'action');
        if (
          !(await timed(`    resume after "${label}"`, () =>
            this.resume(session, state, actions, index),
          ))
        )
          break;
      }
    }
  }

  private async attempt(session: RendererSession, action: Clickable | FormGroup): Promise<Step[]> {
    try {
      if (isForm(action)) return await this.submitForm(session, action);
      const ref = await this.refFor(session, action);
      await session.tap(ref);
      await session.settle();
      return [{ kind: 'tap', target: ref, label: action.label }];
    } catch (error) {
      this.input.diagnostics.push({
        level: 'info',
        stage: 'crawl',
        // §7.11 — a press the page never received is its own fault, not a dead control.
        code: diagnosticCodeFor(error),
        message: `${labelOf(action) ?? action.ref}: ${messageOf(error)}`,
      });
      return [];
    }
  }

  /**
   * §7.11 — a ref is a path through the DOM, and an app that re-renders between the
   * collect and the press moves the path out from under it. Look the control up
   * again by what it is — its label and its target — rather than losing the action.
   */
  private async refFor(
    session: RendererSession,
    want: { ref: string; label: string | null; target?: string | null },
  ): Promise<string> {
    const onScreen = await session.clickables();
    if (onScreen.some((candidate) => candidate.ref === want.ref)) return want.ref;
    const again = onScreen.find(
      (candidate) =>
        candidate.label === want.label &&
        (want.target === undefined || candidate.target === want.target),
    );
    if (again) return again.ref;
    throw new Error(`${STALE_REF_TAG} nothing on the page matches ${want.ref}`);
  }

  /** §7.3 — a form is one action: fill every synthesizable field, then submit. */
  private async submitForm(session: RendererSession, form: FormGroup): Promise<Step[]> {
    const plan = planForm(form);
    if (plan.skipped) {
      this.input.diagnostics.push({
        level: 'info',
        stage: 'crawl',
        code: `form-skipped-${plan.skipped.code}`,
        message: `form ${JSON.stringify(form.label ?? form.ref)}: ${plan.skipped.message}`,
      });
      return [];
    }
    if (!plan.submit) return [];

    const steps: Step[] = [];
    for (const fill of plan.fills) {
      await session.fill(fill.ref, fill.value);
      steps.push({ kind: 'fill', target: fill.ref, value: fill.value, label: fill.label });
    }
    await session.tap(plan.submit.ref);
    await session.settle();
    steps.push({ kind: 'submit', target: plan.submit.ref, label: plan.submit.label });
    return steps;
  }

  private async resume(
    session: RendererSession,
    state: ScreenState,
    actions: readonly (Clickable | FormGroup)[],
    index: number,
  ): Promise<boolean> {
    if (await this.reEstablish(session, state)) return true;

    const rest = actions.slice(index + 1);
    for (const action of rest) this.noteUntried(state, action, 'unreachable');
    if (rest.length) {
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'actions-abandoned',
        message: `${state.signature}: could not be returned to, so ${rest.length} action${rest.length === 1 ? '' : 's'} on it went untried`,
      });
    }
    return false;
  }

  /**
   * §7.4 — back to a state without rebooting the app. Four rungs, cheapest first:
   * already there costs one `observe`; a history move costs a render; a load is
   * the reset that always holds, and it is what an overlay left open needs; a full
   * replay is the last resort for a state no URL rebuilds.
   */
  private async reEstablish(session: RendererSession, state: ScreenState): Promise<boolean> {
    // Not the signature: patterns are learned as the walk goes (§3), so a state
    // recorded before its pattern existed carries a name the crawl has since
    // stopped using. Where the page *is* does not drift like that.
    const arrived = (here: Observation): boolean =>
      stripUrl(here.url) === stripUrl(state.url) && sameOverlays(here.overlays, state.overlays);

    try {
      let here = await timed(`      here?`, () => this.observe(session));
      if (arrived(here)) return true;

      if (stripUrl(here.url) !== stripUrl(state.url)) {
        await timed(`      history ${state.url}`, () => session.goto(state.url, 'history'));
        here = await this.observe(session);
      }

      // A stale overlay is still open, or the router ignored the history move.
      if (stripUrl(here.url) !== stripUrl(state.url) || here.overlays.length > 0) {
        await timed(`      load ${state.url}`, () => session.goto(state.url));
        here = await this.observe(session);
      }

      // What the URL cannot restore: the taps that opened this state's overlay.
      for (const step of this.restoreTail.get(state.signature) ?? []) {
        await timed(`      re-tap ${step.kind} ${step.target}`, async () => {
          if (step.kind === 'goto') return session.goto(step.target, 'history');
          if (step.kind === 'fill') await session.fill(step.target, step.value ?? '');
          else await session.tap(await this.refFor(session, { ref: step.target, label: step.label ?? null }));
          await session.settle();
        });
        here = await this.observe(session);
      }

      if (arrived(here)) return true;

      // Last resort — the whole path from the front door. A state a fresh URL
      // cannot rebuild (a form's landing page, a redirect) is rare enough to pay
      // for, and losing it is worse than the replay it costs.
      here = await timed(`      replay ${state.reachedVia.length} steps`, () =>
        this.replay(session, state.reachedVia),
      );
      if (arrived(here)) return true;

      // Every queued action's ref is a path into a DOM that is no longer on screen.
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'reestablish-drifted',
        message: `${state.signature}: came back to ${here.signature} instead`,
      });
      return false;
    } catch (error) {
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'reestablish-failed',
        message: `${state.signature}: ${messageOf(error)}`,
      });
      return false;
    }
  }

  private async replay(session: RendererSession, steps: readonly Step[]): Promise<Observation> {
    for (const step of steps) {
      if (step.kind === 'goto') {
        await session.goto(step.target);
        continue;
      }
      if (step.kind === 'fill') await session.fill(step.target, step.value ?? '');
      else await session.tap(step.target);
      await session.settle();
    }
    return this.observe(session);
  }

  /**
   * §7.4 — the steps a URL alone cannot restore. An action that moved the URL needs
   * none: the URL is the whole story. An action that did not moved something inside
   * the page — an overlay — and that has to be re-tapped on arrival.
   */
  private tailFor(
    state: ScreenState,
    before: Observation,
    after: Observation,
    performed: Step[],
  ): Step[] {
    if (stripUrl(before.url) !== stripUrl(after.url)) return [];
    return [...(this.restoreTail.get(state.signature) ?? []), ...performed];
  }

  /**
   * §9 — the guard's refusals are part of the map, not a silence in it. A reader who
   * cannot see that "Post" was skipped on purpose has no way to tell a crawl that
   * respected the account from one that never found the button.
   */
  private safeActions<T extends Clickable | FormGroup>(state: ScreenState, actions: T[]): T[] {
    const kept: T[] = [];
    for (const action of actions) {
      const reason = this.input.guard.reasonFor(action);
      if (reason === null) kept.push(action);
      else this.noteUntried(state, action, 'unsafe');
    }
    return kept;
  }

  /**
   * §7.5 — one link per screen. A feed offers the same route once per row, and the
   * canvas draws one node for the pattern either way, so the second row costs a full
   * cycle and changes nothing a reader sees. Runs before the action cap, so the cap
   * counts screens the walk can still learn from.
   */
  private oneLinkPerScreen<T extends Clickable | FormGroup>(state: ScreenState, actions: T[]): T[] {
    const taken = new Set<string>();
    const kept: T[] = [];
    for (const action of actions) {
      const target = 'target' in action ? action.target : null;
      if (!target?.startsWith('/')) {
        kept.push(action);
        continue;
      }
      const screen = this.screenIdOf(target);
      if (taken.has(screen)) {
        this.noteUntried(state, action, 'known-target');
        continue;
      }
      taken.add(screen);
      kept.push(action);
    }
    return kept;
  }

  /**
   * §7.12 — order by the line an action would draw, not by the screen it would find.
   * The old rule asked "is this route already on the map"; phase 2 seeds the whole
   * route table before the walk, so every nav link answered yes and sorted last, and
   * Bluesky's sidebar never survived the action cap. A seeded screen with no way into
   * it is the one thing the map is actually missing.
   */
  private byWhatTheyTeach<T extends Clickable | FormGroup>(actions: T[]): T[] {
    const rank = (action: T): number => {
      const target = isForm(action) ? null : action.target;
      if (!target?.startsWith('/')) return 2; // a button — unknown until pressed
      const screen = this.screenIdOf(target);
      if (!this.reached(screen)) return 1; // a screen the map does not hold yet
      return this.hasWayIn(screen) ? 3 : 0; // holds it: already drawn, or an island
    };
    return actions
      .map((action, index) => ({ action, index, rank: rank(action) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.action);
  }

  /** §7.12 — does the map already show how a reader gets to this screen. */
  private hasWayIn(screen: string): boolean {
    return this.input.edges.some(
      (edge) =>
        edge.discoveredBy === 'runtime' &&
        edge.personaId === this.input.persona.id &&
        edge.to === screen,
    );
  }

  /**
   * §7.12 — a link that leaves the app is not a route. It can only open a tab or
   * take the crawl off the map, and either way the press teaches nothing.
   */
  private inApp<T extends Clickable | FormGroup>(state: ScreenState, actions: T[]): T[] {
    const kept: T[] = [];
    for (const action of actions) {
      if (!isForm(action) && action.external) this.noteUntried(state, action, 'external');
      else kept.push(action);
    }
    return kept;
  }

  /** True once this persona's map holds both the target screen and a line into it. */
  private alreadyDrawn(state: ScreenState, target: string | null): boolean {
    if (!target?.startsWith('/')) return false;
    const screen = this.screenIdOf(target);
    if (!this.reached(screen)) return false;
    return this.input.edges.some(
      (edge) =>
        edge.discoveredBy === 'runtime' &&
        edge.personaId === this.input.persona.id &&
        edge.from === state.screenId &&
        edge.to === screen,
    );
  }

  private screenIdOf(target: string): string {
    const route = canonicalizeUrl(target, [...this.input.matchPatterns, ...this.learned]);
    return this.input.screenIdByRoute.get(route) ?? route;
  }

  private reached(screen: string): boolean {
    return this.input.states.some(
      (state) => state.personaId === this.input.persona.id && state.screenId === screen,
    );
  }

  private noteUntried(
    state: ScreenState,
    action: Clickable | FormGroup,
    reason: UntriedReason,
  ): void {
    const untried = {
      label: labelOf(action),
      target: 'target' in action ? action.target : null,
      reason,
    };
    if (
      state.untriedActions.some(
        (entry) => entry.label === untried.label && entry.target === untried.target,
      )
    )
      return;
    state.untriedActions.push(untried);
  }

  private async observe(session: RendererSession): Promise<Observation> {
    const [url, overlays, fingerprint] = await Promise.all([
      session.url(),
      session.overlays(),
      session.fingerprint(),
    ]);
    this.observePath(url);
    const route = canonicalizeUrl(url, [...this.input.matchPatterns, ...this.learned]);
    const screenId = this.input.screenIdByRoute.get(route) ?? route;
    const refs = overlays.map(toOverlayRef);
    return {
      url,
      route,
      signature: stateSignature(
        screenId,
        refs.map((overlay) => overlay.name),
      ),
      overlays: refs,
      fingerprint,
      routeHandler: this.input.handlerRoutes.has(route),
    };
  }

  private targetsRouteHandler(target: string | null): boolean {
    // In-app only: an off-site URL whose path happens to spell a declared route
    // is not that route, and the landing check covers wherever it does lead.
    if (!target?.startsWith('/')) return false;
    return this.input.handlerRoutes.has(canonicalizeUrl(target, this.input.matchPatterns));
  }

  private discardHandlerLanding(observation: Observation, how: string): boolean {
    if (!observation.routeHandler) return false;
    this.input.diagnostics.push({
      level: 'info',
      stage: 'crawl',
      code: 'route-handler-landing',
      message: `${how} reached ${observation.url}, a route handler (${observation.route}); no screen, no capture`,
    });
    return true;
  }

  private async record(
    session: RendererSession,
    observation: Observation,
    reachedVia: Step[],
    depth: number,
    spend: 'budget' | 'free' = 'budget',
    restoreTail: Step[] = [],
  ): Promise<ScreenState> {
    const existing = this.input.states.find(
      (state) =>
        state.signature === observation.signature && state.personaId === this.input.persona.id,
    );
    if (existing) return existing;

    const state: ScreenState = {
      signature: observation.signature,
      screenId: screenOfStateSignature(observation.signature),
      route: observation.route,
      url: observation.url,
      personaId: this.input.persona.id,
      overlays: observation.overlays,
      capture: null,
      captureStatus: 'not-run',
      reachedVia,
      deadActions: [],
      untriedActions: [],
      fingerprint: observation.fingerprint,
      depth,
    };

    this.restoreTail.set(state.signature, restoreTail);
    await this.capture(session, state);
    this.input.states.push(state);
    this.visited.add(state.signature);
    // §8 — the declared route table is finite and the app's own, so seeding it
    // is not what `maxStates` is for. Spending the walk's budget on it starves
    // the interaction walk on any app with more routes than the bound.
    if (spend === 'budget') this.stateBudget--;
    this.frontier.push(state);
    this.input.log(`  ${this.input.persona.id}  ${state.signature}`);
    return state;
  }

  /** The single call site of screenshot(), which is what makes the privacy rule unskippable. */
  private async capture(session: RendererSession, state: ScreenState) {
    if (this.input.guard.blocksScreenshot(state.route)) {
      state.captureStatus = 'privacy';
      return;
    }

    // §7.10 — the screen has to be old enough to be itself. `settle()` answers a
    // different question and finishes in 0.6s on a warm app, with the skeleton
    // still on show; the shot waits out whatever is left of the floor instead.
    await timed(`      age ${state.signature}`, () => this.holdUntilOldEnough(session));

    // Read once, to say what the picture is of — never to decide when to take it.
    const status = await timed(`      classify ${state.signature}`, () =>
      session.renderStatus(),
    );

    if (status === 'blank') {
      state.captureStatus = 'blank';
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'blank-render',
        message: `${state.signature} rendered nothing at ${state.url}; no capture written`,
      });
      return;
    }
    if (status === 'loading') {
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'loading-capture',
        message: `${state.signature} was still loading ${this.input.config.capture.delayMs}ms after it began; the capture is of that, not of the screen`,
      });
    }
    try {
      const bytes = await timed(`      screenshot ${state.signature}`, () => session.screenshot());
      const file = path.join(
        this.input.outDir,
        ASSET_DIRNAME,
        this.input.persona.id,
        `${slugForFile(state.signature)}.png`,
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      state.capture = {
        path: documentRelative(this.input.outDir, file),
        renderer: session.rendererId,
        renderTarget: session.renderTarget,
        viewport: session.viewport,
        deviceScaleFactor: session.deviceScaleFactor,
      };
      state.captureStatus = status;
    } catch (error) {
      state.captureStatus = 'failed';
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'capture-failed',
        message: `${state.signature}: ${messageOf(error)}`,
      });
    }
  }

  /**
   * §7.10 — `capture.delayMs` is a floor on the screen's age, not a sleep on top of
   * one. Measured on Bluesky, `settle()` returns at 0.6s warm and 1.9s cold, and the
   * screen is only itself at 3s; anchoring to settle inherits that three-fold swing,
   * anchoring to the navigation absorbs it. A screen already older than the floor
   * waits for nothing.
   */
  private async holdUntilOldEnough(session: RendererSession): Promise<void> {
    const remaining = this.input.config.capture.delayMs - session.pageAge();
    if (remaining > 0) await sleep(remaining);
  }

  private addEdge(from: ScreenState, to: ScreenState, label: string | null, kind: string) {
    const id = `runtime:${this.input.persona.id}:${from.signature}->${to.signature}:${label ?? ''}`;
    if (this.input.edges.some((edge) => edge.id === id)) return;
    this.input.edges.push({
      id,
      discoveredBy: 'runtime',
      kind,
      from: from.screenId,
      to: to.screenId,
      fromState: from.signature,
      toState: to.signature,
      label,
      personaId: this.input.persona.id,
      matchKey: edgeMatchKey(from.screenId, to.screenId),
    });
  }

  private recordDeadAction(state: ScreenState, action: Clickable | FormGroup) {
    const dead = {
      label: labelOf(action),
      target: 'target' in action ? action.target : null,
    };
    if (state.deadActions.some((entry) => entry.label === dead.label && entry.target === dead.target)) return;
    state.deadActions.push(dead);
  }

  private async perform(session: RendererSession, step: FlowStep): Promise<Step[]> {
    if ('goto' in step) {
      await session.goto(step.goto);
      return [{ kind: 'goto', target: step.goto }];
    }
    if ('fill' in step) {
      const steps: Step[] = [];
      for (const [ref, value] of Object.entries(step.fill)) {
        await session.fill(ref, value);
        steps.push({ kind: 'fill', target: ref, value });
      }
      return steps;
    }
    if ('submit' in step) {
      await session.tap(step.submit);
      await session.settle();
      return [{ kind: 'submit', target: step.submit }];
    }
    if ('tap' in step) {
      await session.tap(step.tap);
      await session.settle();
      return [{ kind: 'tap', target: step.tap, label: step.label ?? null }];
    }
    // A wait moves nothing, so it records no step and replay does not need it.
    if ('wait' in step) await sleep(step.wait);
    return [];
  }
  
  private observePath(url: string): void {
    const path = stripUrl(url);
    if (this.observedPaths.includes(path)) return;
    this.observedPaths.push(path);

    const before = this.learned.length;
    this.learned = inferRoutePatterns(this.observedPaths);
    for (const pattern of this.learned.slice(before)) {
      this.input.diagnostics.push({
        level: 'info',
        stage: 'crawl',
        code: 'inferred-route',
        message: `${pattern} inferred from observed URLs; the router declared no pattern for it`,
      });
    }
  }

  private hasBudget(): boolean {
    return this.stateBudget > 0 && this.beforeDeadline();
  }

  private beforeDeadline(): boolean {
    return Date.now() < this.deadline;
  }
}

/**
 * A capture the current run did not write is a picture of an older app. Cleared
 * per persona, so crawling one persona leaves the others' captures alone.
 */
function clearCaptures(outDir: string, personaId: string): void {
  const dir = path.join(outDir, ASSET_DIRNAME, personaId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith('.png')) fs.rmSync(path.join(dir, entry), { force: true });
  }
}

function isForm(action: Clickable | FormGroup): action is FormGroup {
  return 'controls' in action;
}

/**
 * §7.3 — a modal's backdrop swallows every click meant for the page behind it, so
 * on an overlay state the page below is not actionable, and each control there
 * costs the action cap a timeout. Kept permissive: an overlay whose contents are
 * not recognized as inside it (§3.1's inert-background case) keeps its actions.
 */
function actionsWithinOverlay<T extends Clickable | FormGroup>(
  state: ScreenState,
  actions: T[],
): T[] {
  if (!state.overlays.length) return actions;
  const inside = actions.filter((action) =>
    isForm(action) ? (action.submit?.inOverlay ?? false) : action.inOverlay,
  );
  return inside.length ? inside : actions;
}

function labelOf(action: Clickable | FormGroup): string | null {
  if (isForm(action)) return action.label ?? action.submit?.label ?? 'submit';
  return action.label;
}

function labelOfStep(step: FlowStep): string | null {
  if ('tap' in step) return step.label ?? step.tap;
  if ('submit' in step) return 'submit';
  if ('goto' in step) return step.goto;
  return null;
}

function toOverlayRef(overlay: Overlay): OverlayRef {
  return {
    name: overlay.name ? slugify(overlay.name) : overlay.subtreeHash,
    role: overlay.role,
    via: overlay.via,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * §7.11 — three ways an action can not happen, and they mean different things: the
 * page never received the press, the ref no longer matches anything, or the control
 * itself refused. One bucket for all three is how 233 blocked clicks hid for a run.
 */
function diagnosticCodeFor(error: unknown): string {
  if (isIntercepted(error)) return 'action-intercepted';
  if (isStaleRef(error)) return 'action-ref-stale';
  return 'action-failed';
}

function sameOverlays(here: readonly OverlayRef[], wanted: readonly OverlayRef[]): boolean {
  return (
    here.length === wanted.length &&
    here.every((overlay, index) => overlay.name === wanted[index]!.name)
  );
}

function unchanged(before: Observation, after: Observation): boolean {
  return before.signature === after.signature && before.fingerprint === after.fingerprint;
}

/**
 * A link pointing at the route we are already on, that moved nothing after a full
 * settle, is dead for certain — no second look needed. Anything else might still
 * be a transition that has not committed.
 */
function mayStillNavigate(action: Clickable | FormGroup, currentRoute: string): boolean {
  if (isForm(action)) return true;
  if (!action.target) return true;
  return canonicalizeUrl(action.target) !== currentRoute;
}
