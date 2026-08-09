import { computeCoverage, markConfirmedEdges } from './coverage.js';
import type { ResolvedConfig } from './config.js';
import { detect } from './detect.js';
import { select, type NavRecognizers, type ProviderRegistry } from './providers.js';
import { edgeMatchKey } from './route.js';
import { crawl } from './stages/crawl.js';
import { parse } from './stages/parse.js';
import { emptyDocument, type JsxrayDocument, type StageName } from './schema.js';

const EMPTY_RECOGNIZERS: NavRecognizers = { linkProps: [], calls: [] };

export interface RunOptions {
  root: string;
  outDir: string;
  config: ResolvedConfig;
  registry: ProviderRegistry;
  version: string;
  stages?: StageName[] | null;
  staticOnly?: boolean;
  headed?: boolean;
  personaIds?: string[] | null;
  url?: string | null;
  log?: (message: string) => void;
}

export async function run(options: RunOptions): Promise<JsxrayDocument> {
  const log = options.log ?? (() => undefined);
  const document = emptyDocument(options.root, options.version);
  const wanted = (stage: StageName): boolean =>
    !options.stages || stage === 'detect' || options.stages.includes(stage);

  document.personas = options.config.personas.map((persona) => ({
    id: persona.id,
    authenticated: Boolean(persona.login),
  }));

  document.framework = detect(options.root);
  document.stages.push({ name: 'detect', status: 'ok' });
  log(`detect  ${describeStack(document)}`);

  // §6 — provider selection happens once, for all four axes.
  const parser = select(options.registry.parser, document.framework);
  const router = select(options.registry.router, document.framework);
  const renderer = select(options.registry.renderer, document.framework);
  const auth = select(options.registry.auth, document.framework);
  document.providers = {
    parser: parser?.id ?? null,
    router: router?.id ?? null,
    renderer: renderer?.id ?? null,
    auth: auth?.id ?? null,
  };

  if (wanted('parse')) {
    if (!parser) {
      document.stages.push({ name: 'parse', status: 'skipped' });
      document.diagnostics.push({
        level: 'warn',
        stage: 'parse',
        code: 'no-parser-provider',
        message: `no parser supports ui "${document.framework.ui ?? 'unknown'}"`,
      });
    } else {
      try {
        const output = await parse({
          root: options.root,
          profile: document.framework,
          parser,
          recognizers: router?.recognizers ?? EMPTY_RECOGNIZERS,
        });
        document.components = output.components;
        document.navIntents = output.navIntents;
        document.diagnostics.push(...output.diagnostics);
        document.stages.push({ name: 'parse', status: 'ok', provider: parser.id });
        log(`parse   ${output.components.length} components, ${output.navIntents.length} nav intents`);

        if (!router) {
          document.diagnostics.push({
            level: 'info',
            stage: 'parse',
            code: 'no-recognizers',
            message: 'no router provider, so no navigation was recognized (§4.1)',
          });
        }

        if (wanted('enumerate')) {
          if (!router) {
            document.stages.push({ name: 'enumerate', status: 'skipped' });
            document.diagnostics.push({
              level: 'warn',
              stage: 'enumerate',
              code: 'no-router-provider',
              message: `detected router "${document.framework.router ?? 'none'}"; supported: next-app, next-pages, react-router (file), tanstack-router. The crawl still runs from seedRoutes; coverage reports null (§4.3)`,
            });
          } else {
            const enumerated = await router.enumerate({
              root: options.root,
              profile: document.framework,
              fileExports: output.fileExports,
              navIntents: output.navIntents,
            });
            document.screens = enumerated.screens;
            document.edges = enumerated.edges;
            document.diagnostics.push(...enumerated.diagnostics);
            document.stages.push({
              name: 'enumerate',
              status: 'ok',
              provider: router.id,
              note: enumerated.strategy,
            });
            log(`enum    ${enumerated.screens.length} screens, ${enumerated.edges.length} candidate edges`);
          }
        }
      } catch (error) {
        document.stages.push({ name: 'parse', status: 'failed' });
        document.diagnostics.push({
          level: 'error',
          stage: 'parse',
          code: 'parse-failed',
          message: messageOf(error),
        });
      }
    }
  }

  if (wanted('crawl') && !options.staticOnly) {
    if (!renderer) {
      document.stages.push({ name: 'crawl', status: 'skipped' });
      document.diagnostics.push({
        level: 'warn',
        stage: 'crawl',
        code: 'no-renderer-provider',
        message: `no renderer supports renderTarget "${document.framework.renderTarget}"`,
      });
    } else {
      log(`crawl   ${options.url ?? options.config.url}`);
      const output = await crawl({
        document,
        config: options.config,
        renderer,
        auth,
        outDir: options.outDir,
        baseUrl: options.url ?? options.config.url,
        headed: options.headed ?? false,
        personaIds: options.personaIds ?? null,
        log,
      });
      document.states = output.states;
      document.edges.push(...output.edges);
      document.diagnostics.push(...output.diagnostics);
      document.stages.push({
        name: 'crawl',
        status: output.states.length ? 'ok' : 'failed',
        provider: renderer.id,
      });
      log(`crawl   ${output.states.length} states, ${output.edges.length} runtime edges`);
    }
  } else if (wanted('crawl')) {
    document.stages.push({ name: 'crawl', status: 'skipped', note: 'static-only' });
  }

  for (const edge of document.edges) {
    if (edge.discoveredBy === 'static') edge.matchKey = edgeMatchKey(edge.from, edge.to);
  }
  markConfirmedEdges(document);
  document.coverage = computeCoverage(document);
  return document;
}

function describeStack(document: JsxrayDocument): string {
  const profile = document.framework;
  if (!profile) return 'unknown';
  return [profile.ui, profile.metaFramework, profile.router].filter(Boolean).join(' · ') || 'unknown';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
