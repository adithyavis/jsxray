import type { Credentials, LoginFlow } from './config.js';
import type {
  Box,
  ComponentRecord,
  Diagnostic,
  Edge,
  FrameworkProfile,
  NavEdgeKind,
  NavIntent,
  RenderTarget,
  Screen,
} from './schema.js';
import type { Clickable, ElementRef, FormGroup, Overlay, SessionState } from './runtime.js';

export type Axis = 'parser' | 'router' | 'renderer' | 'auth';

export interface ProviderBase<Caps> {
  readonly axis: Axis;
  readonly id: string;
  readonly priority: number;
  readonly capabilities: Caps;
  supports(profile: FrameworkProfile): boolean;
}

export interface ParserCapabilities {
  extensions: string[];
  /** v2. */
  buildTree: boolean;
}

export interface ParseInput {
  root: string;
  files: string[];
  recognizers: NavRecognizers;
  profile: FrameworkProfile;
}

export interface FileExports {
  file: string;
  defaultComponentId: string | null;
  named: Record<string, string>;
}

export interface ParseOutput {
  components: ComponentRecord[];
  navIntents: NavIntent[];
  fileExports: FileExports[];
  diagnostics: Diagnostic[];
}

export interface ParserProvider extends ProviderBase<ParserCapabilities> {
  readonly axis: 'parser';
  prefilter(file: string, source: string): boolean;
  parse(input: ParseInput): Promise<ParseOutput>;
}

/** §4.1 — the router supplies these and the parser applies them. */
export interface NavRecognizers {
  linkProps: { element: string; prop: string }[];
  calls: {
    callee: string;
    kind: NavEdgeKind;
    target: { arg: number; key?: string };
  }[];
}

export type DiscoveryStrategy = 'generated' | 'file' | 'config';

export interface RouterCapabilities {
  /** Ordered, not a boolean (§4). */
  discovery: DiscoveryStrategy[];
}

export interface EnumerateInput {
  root: string;
  profile: FrameworkProfile;
  fileExports: FileExports[];
  navIntents: NavIntent[];
}

export interface EnumerateOutput {
  screens: Screen[];
  edges: Edge[];
  strategy: DiscoveryStrategy;
  diagnostics: Diagnostic[];
}

export interface RouterProvider extends ProviderBase<RouterCapabilities> {
  readonly axis: 'router';
  readonly recognizers: NavRecognizers;
  enumerate(input: EnumerateInput): Promise<EnumerateOutput>;
}

export interface RendererCapabilities {
  renderTargets: RenderTarget[];
  sessionPersistence: boolean;
  determinismFreeze: boolean;
  /** v2. */
  elementBoxes: boolean;
}

export interface LaunchOptions {
  baseUrl: string;
  headed: boolean;
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  timeoutMs: number;
  /** Drive an installed browser instead of the bundled one. */
  channel?: string | null;
}

export interface RendererSession {
  readonly rendererId: string;
  readonly renderTarget: RenderTarget;
  readonly viewport: { width: number; height: number };
  readonly deviceScaleFactor: number;

  freeze(): Promise<void>;
  goto(target: string): Promise<void>;
  settle(): Promise<void>;
  url(): Promise<string>;
  fingerprint(): Promise<string>;
  overlays(): Promise<Overlay[]>;
  screenshot(): Promise<Uint8Array>;
  clickables(): Promise<Clickable[]>;
  forms(): Promise<FormGroup[]>;
  tap(ref: ElementRef): Promise<void>;
  fill(ref: ElementRef, value: string): Promise<void>;
  session(): Promise<SessionState>;
  restore(state: SessionState): Promise<void>;
  /** v2. */
  elementBoxes?(): Promise<Box[]>;
  close(): Promise<void>;
}

export interface RendererProvider extends ProviderBase<RendererCapabilities> {
  readonly axis: 'renderer';
  launch(options: LaunchOptions): Promise<RendererSession>;
}

export interface AuthCapabilities {
  sessionCheck: boolean;
}

export interface AuthProvider extends ProviderBase<AuthCapabilities> {
  readonly axis: 'auth';
  login(
    session: RendererSession,
    credentials: Credentials,
    loginFlow: LoginFlow | null,
  ): Promise<void>;
  /** Optional (§7.6). */
  isLoggedIn?(session: RendererSession): Promise<boolean>;
}

export interface ProviderRegistry {
  parser: ParserProvider[];
  router: RouterProvider[];
  renderer: RendererProvider[];
  auth: AuthProvider[];
}

export function select<P extends ProviderBase<unknown>>(
  candidates: readonly P[],
  profile: FrameworkProfile,
): P | null {
  const supported = candidates.filter((provider) => provider.supports(profile));
  if (!supported.length) return null;
  return [...supported].sort((a, b) => b.priority - a.priority)[0]!;
}
