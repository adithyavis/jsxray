export const SCHEMA_VERSION = 1;

export type StageName = 'detect' | 'parse' | 'enumerate' | 'crawl' | 'link';
export type DiagnosticLevel = 'error' | 'warn' | 'info';

export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}

export interface Diagnostic {
  level: DiagnosticLevel;
  stage: StageName | 'config' | 'pipeline';
  code: string;
  message: string;
  loc?: SourceLoc | null;
}

export type UiKind = 'react' | 'vue' | (string & {});
export type MetaFrameworkKind = 'next' | 'vite' | 'remix' | 'expo' | 'nuxt' | 'cra' | (string & {});
export type RouterKind =
  | 'next-app'
  | 'next-pages'
  | 'react-router'
  | 'react-router-config'
  | 'tanstack-router'
  | 'expo-router'
  | 'vue-router'
  | 'react-navigation'
  | (string & {});
export type RenderTarget = 'web' | 'native' | (string & {});

export interface Evidence {
  fact: string;
  source: string;
  detail?: string;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  sourceDir: string;
}

export interface FrameworkProfile {
  ui: UiKind | null;
  metaFramework: MetaFrameworkKind | null;
  router: RouterKind | null;
  routerRoot: string | null;
  renderTarget: RenderTarget;
  typescript: boolean;
  sourceRoots: string[];
  workspaces: WorkspacePackage[];
  evidence: Evidence[];
}

export type ComponentKind =
  | 'function'
  | 'class'
  | 'memo'
  | 'forwardRef'
  | 'anonymous'
  | 'render-nothing'
  | (string & {});

export interface ComponentRecord {
  id: string;
  name: string;
  file: string;
  loc: SourceLoc;
  kind: ComponentKind;
  isPage: boolean;
  renders: ElementUsage[] | null;
  guards: Guard[] | null;
  props: PropSignature[] | null;
  designSystem: DesignSystemOrigin | null;
}

/** v2. Element usage, not JSX — a Vue template node is one too (§4.2). */
export interface ElementUsage {
  name: string;
  props: Record<string, string | null>;
  children: ElementUsage[];
  componentId: string | null;
  package: string | null;
  loc: SourceLoc;
}

/** v2. `condition` always reads as "renders when this holds" (§11.3). */
export interface Guard {
  kind: 'and' | 'ternary' | 'fallback' | 'early-return' | (string & {});
  condition: string;
  identifiers: string[];
  loc: SourceLoc;
}

/** v2. */
export interface PropSignature {
  name: string;
  type: string | null;
  required: boolean;
}

/** v2. */
export interface DesignSystemOrigin {
  source: 'package' | 'vendored' | 'workspace' | (string & {});
  name: string;
  aliasOf: string | null;
}

export type ScreenKind =
  | 'page'
  | 'layout'
  | 'route-handler'
  | 'not-found'
  | 'error'
  | 'loading'
  | (string & {});

export interface ScreenMeta {
  groups: string[];
  dynamic: boolean;
  params: string[];
  intercepted?: boolean;
}

export interface Screen {
  id: string;
  route: string;
  pattern: string;
  kind: ScreenKind;
  isPage: boolean;
  file: string | null;
  componentId: string | null;
  layoutComponentIds: string[];
  meta: ScreenMeta;
  tree: ElementUsage | null;
  layoutTrees: ElementUsage[] | null;
}

export type NavEdgeKind =
  | 'link'
  | 'push'
  | 'replace'
  | 'redirect'
  | 'back'
  | 'form'
  | 'action'
  | (string & {});

export interface NavIntent {
  kind: NavEdgeKind;
  target: string | null;
  targetExpression: string | null;
  trigger: string | null;
  componentId: string | null;
  loc: SourceLoc;
}

export interface Edge {
  id: string;
  discoveredBy: 'static' | 'runtime';
  kind: NavEdgeKind;
  from: string;
  to: string | null;
  fromState?: string;
  toState?: string;
  label: string | null;
  personaId?: string | null;
  componentId?: string | null;
  loc?: SourceLoc | null;
  targetExpression?: string | null;
  /** §5.1 — what a runtime edge confirms a candidate by. */
  matchKey: string | null;
  confirmedBy?: string[] | null;
}

export interface PersonaRecord {
  id: string;
  authenticated: boolean;
}

export interface OverlayRef {
  name: string;
  role: string;
  via: 'role' | 'dialog-element' | 'inert-background' | (string & {});
}

export interface Capture {
  /** Document-relative (§2). */
  path: string;
  renderer: string;
  renderTarget: RenderTarget;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

export interface Step {
  kind: 'goto' | 'tap' | 'fill' | 'submit' | (string & {});
  target: string;
  value?: string | null;
  label?: string | null;
}

export interface DeadAction {
  label: string | null;
  target: string | null;
}

export interface ScreenState {
  signature: string;
  screenId: string;
  route: string;
  url: string;
  personaId: string;
  overlays: OverlayRef[];
  capture: Capture | null;
  captureSkipped: 'privacy' | 'not-run' | 'failed' | 'blank' | null;
  reachedVia: Step[];
  deadActions: DeadAction[];
  fingerprint: string;
  depth: number;
}

export interface CoverageEntry {
  screensDeclared: number | null;
  screensReached: number;
  screenRatio: number | null;
  edgesConfirmed: number;
  edgesUnconfirmed: number;
  edgesUnmatchable: number;
  edgesMatchable: number;
  edgeRatio: number | null;
}

export interface Coverage {
  overall: CoverageEntry;
  byPersona: Record<string, CoverageEntry>;
}

export interface StageRecord {
  name: StageName;
  status: 'ok' | 'skipped' | 'failed';
  provider?: string | null;
  note?: string | null;
}

/** v2. */
export interface Box {
  stateSignature: string;
  rect: { x: number; y: number; width: number; height: number };
  componentId: string | null;
  loc: SourceLoc | null;
}

export interface SelectedProviders {
  parser: string | null;
  router: string | null;
  renderer: string | null;
  auth: string | null;
}

export interface JsxrayDocument {
  schemaVersion: number;
  generator: { name: 'jsxray'; version: string };
  /** The one absolute path in the document (§2). */
  root: string;
  framework: FrameworkProfile | null;
  providers: SelectedProviders;
  /** §14 — where the reader enters the app, and the only root the canvas draws from. */
  seedRoutes: string[];
  components: ComponentRecord[];
  navIntents: NavIntent[];
  screens: Screen[];
  edges: Edge[];
  personas: PersonaRecord[];
  states: ScreenState[];
  coverage: Coverage | null;
  diagnostics: Diagnostic[];
  stages: StageRecord[];
  boxes: Box[];
}

export function emptyDocument(root: string, version: string): JsxrayDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'jsxray', version },
    root,
    framework: null,
    providers: { parser: null, router: null, renderer: null, auth: null },
    seedRoutes: [],
    components: [],
    navIntents: [],
    screens: [],
    edges: [],
    personas: [],
    states: [],
    coverage: null,
    diagnostics: [],
    stages: [],
    boxes: [],
  };
}
