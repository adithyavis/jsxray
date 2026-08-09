import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';

export const DEFAULT_OUT_DIR = '.jsxray';
export const DOCUMENT_FILENAME = 'jsxray.json';
export const ASSET_DIRNAME = 'assets';

/** A marker, not a value — the value is read during `crawl` and never serialized (§9). */
export interface EnvRef {
  readonly __jsxrayEnv: string;
}

export function env(name: string): EnvRef {
  return { __jsxrayEnv: name };
}

export function isEnvRef(value: unknown): value is EnvRef {
  return typeof value === 'object' && value !== null && '__jsxrayEnv' in value;
}

export type FlowStep =
  | { goto: string }
  | { tap: string; label?: string }
  | { fill: Record<string, string> }
  | { submit: string }
  | { wait: number };

export interface LoginFlow {
  start?: string;
  steps: FlowStep[];
  expect?: string;
}

export interface NamedFlow {
  id: string;
  personas?: string[];
  start?: string;
  steps: FlowStep[];
}

export interface PersonaConfig {
  id: string;
  /** Absent means the logged-out visitor — a persona, not an absence (§7.6). */
  login?: {
    username: string | EnvRef;
    password: string | EnvRef;
  };
}

export interface IgnoreRules {
  navigation?: string[];
  actions?: string[];
  screenshots?: string[];
}

export interface Bounds {
  maxDepth?: number;
  maxStates?: number;
  actionCap?: number;
  timeoutMs?: number;
}

export interface JsxrayConfig {
  url?: string;
  personas?: PersonaConfig[];
  loginFlow?: LoginFlow;
  flows?: NamedFlow[];
  seedRoutes?: string[];
  ignore?: IgnoreRules;
  out?: string;
  renderTarget?: 'web' | 'native';
  viewport?: { width: number; height: number };
  /** Drive an installed browser instead of the bundled one, e.g. `'chrome'`. */
  channel?: string | null;
  bounds?: Bounds;
}

export interface ResolvedConfig {
  url: string;
  personas: PersonaConfig[];
  loginFlow: LoginFlow | null;
  flows: NamedFlow[];
  seedRoutes: string[];
  ignore: Required<IgnoreRules>;
  out: string;
  renderTarget: 'web' | 'native';
  viewport: { width: number; height: number };
  channel: string | null;
  bounds: Required<Bounds>;
  configFile: string | null;
}

export function defineConfig(config: JsxrayConfig): JsxrayConfig {
  return config;
}

export function resolveConfig(config: JsxrayConfig, configFile: string | null): ResolvedConfig {
  return {
    url: config.url ?? 'http://localhost:3000',
    personas: config.personas?.length ? config.personas : [{ id: 'anon' }],
    loginFlow: config.loginFlow ?? null,
    flows: config.flows ?? [],
    seedRoutes: config.seedRoutes ?? ['/'],
    ignore: {
      navigation: config.ignore?.navigation ?? [],
      actions: config.ignore?.actions ?? [],
      screenshots: config.ignore?.screenshots ?? [],
    },
    out: config.out ?? DEFAULT_OUT_DIR,
    renderTarget: config.renderTarget ?? 'web',
    viewport: config.viewport ?? { width: 1280, height: 800 },
    channel: config.channel ?? null,
    bounds: {
      maxDepth: config.bounds?.maxDepth ?? 4,
      maxStates: config.bounds?.maxStates ?? 120,
      actionCap: config.bounds?.actionCap ?? 12,
      timeoutMs: config.bounds?.timeoutMs ?? 10 * 60_000,
    },
    configFile,
  };
}

const CONFIG_FILENAMES = [
  'jsxray.config.ts',
  'jsxray.config.mts',
  'jsxray.config.js',
  'jsxray.config.mjs',
];

export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadConfig(root: string, explicit?: string | null): Promise<ResolvedConfig> {
  const file = explicit ? path.resolve(root, explicit) : findConfigFile(root);
  if (!file) return resolveConfig({}, null);
  const jiti = createJiti(root, { interopDefault: true, moduleCache: false });
  const loaded = (await jiti.import(file, { default: true })) as JsxrayConfig | undefined;
  return resolveConfig(loaded ?? {}, file);
}

export interface Credentials {
  username: string;
  password: string;
}

export function resolveCredentials(persona: PersonaConfig): Credentials | null {
  if (!persona.login) return null;
  const read = (value: string | EnvRef, field: string): string => {
    if (!isEnvRef(value)) return value;
    const found = process.env[value.__jsxrayEnv];
    if (found === undefined) {
      throw new Error(
        `Persona "${persona.id}" needs ${field} from $${value.__jsxrayEnv}, which is not set.`,
      );
    }
    return found;
  };
  return {
    username: read(persona.login.username, 'username'),
    password: read(persona.login.password, 'password'),
  };
}
