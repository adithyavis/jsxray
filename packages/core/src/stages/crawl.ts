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
  isDynamic,
  screenOfStateSignature,
  stateSignature,
} from '../route.js';
import type { Clickable, FormGroup, Overlay } from '../runtime.js';
import type {
  Diagnostic,
  Edge,
  JsxrayDocument,
  OverlayRef,
  ScreenState,
  Step,
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
  const personas = config.personas.filter(
    (persona) => !input.personaIds || input.personaIds.includes(persona.id),
  );

  for (const persona of personas) {
    const walker = new PersonaCrawl({
      persona,
      config,
      guard,
      patterns,
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
        headed: input.headed,
        viewport: config.viewport,
        timeoutMs: config.bounds.timeoutMs,
        channel: config.channel,
      });

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

  return { states, edges, diagnostics };
}

interface PersonaCrawlInput {
  persona: PersonaConfig;
  config: ResolvedConfig;
  guard: SafetyGuard;
  patterns: string[];
  screenIdByRoute: Map<string, string>;
  outDir: string;
  diagnostics: Diagnostic[];
  states: ScreenState[];
  edges: Edge[];
  log(message: string): void;
}

class PersonaCrawl {
  private readonly visited = new Set<string>();
  private readonly frontier: ScreenState[] = [];
  private readonly deadline: number;
  private stateBudget: number;

  constructor(private readonly input: PersonaCrawlInput) {
    this.deadline = Date.now() + input.config.bounds.timeoutMs;
    this.stateBudget = input.config.bounds.maxStates;
  }

  async run(session: RendererSession, auth: AuthProvider | null, authenticated: boolean) {
    await this.runFlows(session);
    await this.runSeeds(session);
    await this.runWalk(session, auth, authenticated);
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
          await session.settle();
          steps.push({ kind: 'goto', target: flow.start });
        }
        let previous = await this.observe(session);
        let previousState = await this.record(session, previous, [...steps], 0);

        for (const step of flow.steps) {
          const recorded = await this.perform(session, step);
          steps.push(...recorded);
          const next = await this.observe(session);
          if (next.signature === previous.signature) continue;
          const nextState = await this.record(session, next, [...steps], previousState.depth + 1);
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

    for (const route of unique([...config.seedRoutes, ...declared])) {
      if (guard.blocksNavigation(route)) continue;
      if (!this.hasBudget()) return;
      try {
        await session.goto(route);
        await session.settle();
        const observation = await this.observe(session);
        if (this.visited.has(observation.signature)) continue;
        await this.record(session, observation, [{ kind: 'goto', target: route }], 0);
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
      if (state.depth >= config.bounds.maxDepth) continue;
      if (guard.blocksActions(state.route)) continue;

      if (authenticated && auth?.isLoggedIn) {
        if (!(await auth.isLoggedIn(session))) {
          const credentials = resolveCredentials(persona);
          if (credentials) await auth.login(session, credentials, config.loginFlow);
        }
      }

      if (!(await this.reEstablish(session, state))) continue;

      const actions = guard
        .filterActions<Clickable | FormGroup>([
          ...(await session.clickables()),
          ...(await session.forms()),
        ])
        .slice(0, config.bounds.actionCap);

      for (const action of actions) {
        if (!this.hasBudget()) return;
        if ('target' in action && guard.blocksNavigation(action.target)) continue;

        const before = await this.observe(session);
        const performed = await this.attempt(session, action);
        if (!performed.length) {
          await this.reEstablish(session, state);
          continue;
        }

        let after = await this.observe(session);
        if (unchanged(before, after) && mayStillNavigate(action, before.route)) {
          // Confirm before scoring it dead: a transition may not have committed yet.
          await session.settle();
          after = await this.observe(session);
        }
        if (unchanged(before, after)) {
          this.recordDeadAction(state, action);
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
          await this.reEstablish(session, state);
          continue;
        }

        const steps = [...state.reachedVia, ...performed];
        const next = await this.record(session, after, steps, state.depth + 1);
        this.addEdge(state, next, labelOf(action), 'form' in action ? 'form' : 'action');
        await this.reEstablish(session, state);
      }
    }
  }

  private async attempt(session: RendererSession, action: Clickable | FormGroup): Promise<Step[]> {
    try {
      if (isForm(action)) return await this.submitForm(session, action);
      await session.tap(action.ref);
      await session.settle();
      return [{ kind: 'tap', target: action.ref, label: action.label }];
    } catch (error) {
      this.input.diagnostics.push({
        level: 'info',
        stage: 'crawl',
        code: 'action-failed',
        message: `${labelOf(action) ?? action.ref}: ${messageOf(error)}`,
      });
      return [];
    }
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

  /** §7.4 — backtracking by replay, not history. */
  private async reEstablish(session: RendererSession, state: ScreenState): Promise<boolean> {
    try {
      for (const step of state.reachedVia) {
        if (step.kind === 'goto') await session.goto(step.target);
        else if (step.kind === 'fill') await session.fill(step.target, step.value ?? '');
        else await session.tap(step.target);
        await session.settle();
      }
      if (!state.reachedVia.length) {
        await session.goto(state.url);
        await session.settle();
      }
      return true;
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

  private async observe(session: RendererSession): Promise<Observation> {
    const [url, overlays, fingerprint] = await Promise.all([
      session.url(),
      session.overlays(),
      session.fingerprint(),
    ]);
    const route = canonicalizeUrl(url, this.input.patterns);
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
    };
  }

  private async record(
    session: RendererSession,
    observation: Observation,
    reachedVia: Step[],
    depth: number,
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
      captureSkipped: null,
      reachedVia,
      deadActions: [],
      fingerprint: observation.fingerprint,
      depth,
    };

    await this.capture(session, state);
    this.input.states.push(state);
    this.visited.add(state.signature);
    this.stateBudget--;
    this.frontier.push(state);
    this.input.log(`  ${this.input.persona.id}  ${state.signature}`);
    return state;
  }

  /** The single call site of screenshot(), which is what makes the privacy rule unskippable. */
  private async capture(session: RendererSession, state: ScreenState) {
    if (this.input.guard.blocksScreenshot(state.route)) {
      state.captureSkipped = 'privacy';
      return;
    }
    try {
      const bytes = await session.screenshot();
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
    } catch (error) {
      state.captureSkipped = 'failed';
      this.input.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'capture-failed',
        message: `${state.signature}: ${messageOf(error)}`,
      });
    }
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
      await session.settle();
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
    return [];
  }

  private hasBudget(): boolean {
    return this.stateBudget > 0 && Date.now() < this.deadline;
  }
}

function isForm(action: Clickable | FormGroup): action is FormGroup {
  return 'controls' in action;
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
