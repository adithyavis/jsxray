import fs from 'node:fs';
import path from 'node:path';
import { exists, isDirectory, readJson } from './fs-utils.js';
import { toPosix } from './paths.js';
import type { Evidence, FrameworkProfile, RouterKind, WorkspacePackage } from './schema.js';

interface PackageJson {
  name?: string;
  source?: string;
  main?: string;
  module?: string;
  publishConfig?: { source?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export function detect(root: string): FrameworkProfile {
  const pkg = readJson<PackageJson>(path.join(root, 'package.json'));
  if (!pkg) throw new Error(`No package.json in ${root} — jsxray needs one to detect the stack.`);

  const evidence: Evidence[] = [];
  const deps = allDependencies(pkg);
  const has = (name: string): boolean => name in deps;

  const ui = detectUi(has, evidence);
  const metaFramework = detectMetaFramework(has, evidence);
  const { router, routerRoot } = detectRouter(root, has, metaFramework, evidence);

  const typescript = exists(path.join(root, 'tsconfig.json'));
  if (typescript) evidence.push({ fact: 'typescript', source: 'tsconfig.json' });

  const workspaces = detectWorkspaces(root, pkg, evidence);
  const renderTarget = metaFramework === 'expo' ? 'native' : 'web';

  return {
    ui,
    metaFramework,
    router,
    routerRoot,
    renderTarget,
    typescript,
    sourceRoots: sourceRoots(root, routerRoot, workspaces),
    workspaces,
    evidence,
  };
}

function allDependencies(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
}

function detectUi(has: (name: string) => boolean, evidence: Evidence[]): string | null {
  if (has('react') || has('react-dom')) {
    evidence.push({ fact: 'ui: react', source: 'package.json' });
    return 'react';
  }
  if (has('vue')) {
    evidence.push({ fact: 'ui: vue', source: 'package.json' });
    return 'vue';
  }
  evidence.push({ fact: 'ui: none recognized', source: 'package.json' });
  return null;
}

function detectMetaFramework(
  has: (name: string) => boolean,
  evidence: Evidence[],
): string | null {
  const table: [string, string][] = [
    ['next', 'next'],
    ['expo', 'expo'],
    ['nuxt', 'nuxt'],
    ['@remix-run/react', 'remix'],
    ['react-scripts', 'cra'],
    ['vite', 'vite'],
    ['react-native', 'react-native']
  ];
  for (const [dependency, name] of table) {
    if (has(dependency)) {
      evidence.push({ fact: `metaFramework: ${name}`, source: 'package.json', detail: dependency });
      return name;
    }
  }
  return null;
}

function detectRouter(
  root: string,
  has: (name: string) => boolean,
  metaFramework: string | null,
  evidence: Evidence[],
): { router: RouterKind | null; routerRoot: string | null } {
  if (metaFramework === 'next') {
    const appDir = ['app', 'src/app'].find((dir) => isDirectory(path.join(root, dir)));
    if (appDir) {
      evidence.push({ fact: 'router: next-app', source: appDir });
      return { router: 'next-app', routerRoot: appDir };
    }
    const pagesDir = ['pages', 'src/pages'].find((dir) => isDirectory(path.join(root, dir)));
    if (pagesDir) {
      evidence.push({ fact: 'router: next-pages', source: pagesDir });
      return { router: 'next-pages', routerRoot: pagesDir };
    }
  }

  if (has('expo-router')) {
    const appDir = ['app', 'src/app'].find((dir) => isDirectory(path.join(root, dir)));
    evidence.push({ fact: 'router: expo-router', source: appDir ?? 'package.json' });
    return { router: 'expo-router', routerRoot: appDir ?? null };
  }

  if (has('@tanstack/react-router')) {
    const generated = ['src/routeTree.gen.ts', 'app/routeTree.gen.ts', 'routeTree.gen.ts'].find(
      (file) => exists(path.join(root, file)),
    );
    const routesDir = ['src/routes', 'app/routes', 'routes'].find((dir) =>
      isDirectory(path.join(root, dir)),
    );
    evidence.push({
      fact: 'router: tanstack-router',
      source: generated ?? routesDir ?? 'package.json',
      detail: generated ? 'generated route tree' : 'file convention',
    });
    return { router: 'tanstack-router', routerRoot: generated ?? routesDir ?? null };
  }

  if (has('react-router') || has('react-router-dom') || has('@react-router/dev')) {
    const routesDir = ['app/routes', 'src/routes', 'routes'].find((dir) =>
      isDirectory(path.join(root, dir)),
    );
    if (routesDir) {
      evidence.push({ fact: 'router: react-router', source: routesDir });
      return { router: 'react-router', routerRoot: routesDir };
    }
    evidence.push({
      fact: 'router: react-router-config',
      source: 'package.json',
      detail: 'no file convention found; config mode is v2',
    });
    return { router: 'react-router-config', routerRoot: null };
  }

  if (has('vue-router')) {
    evidence.push({ fact: 'router: vue-router', source: 'package.json' });
    return { router: 'vue-router', routerRoot: null };
  }

  if (has('@react-navigation/native')) {
    evidence.push({ fact: 'router: react-navigation', source: 'package.json' });
    return { router: 'react-navigation', routerRoot: null };
  }

  evidence.push({ fact: 'router: none recognized', source: 'package.json' });
  return { router: null, routerRoot: null };
}

function detectWorkspaces(
  root: string,
  pkg: PackageJson,
  evidence: Evidence[],
): WorkspacePackage[] {
  const patterns = workspacePatterns(root, pkg);
  if (!patterns.length) return [];

  const found: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      const manifest = readJson<PackageJson>(path.join(dir, 'package.json'));
      if (!manifest?.name) continue;
      found.push({
        name: manifest.name,
        dir: toPosix(path.relative(root, dir)),
        sourceDir: workspaceSourceDir(root, dir, manifest),
      });
    }
  }

  if (found.length) {
    evidence.push({
      fact: `workspace packages: ${found.length}`,
      source: 'package.json#workspaces',
      detail: found.map((entry) => entry.name).join(', '),
    });
  }
  return found;
}

function workspacePatterns(root: string, pkg: PackageJson): string[] {
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (pkg.workspaces?.packages) return pkg.workspaces.packages;

  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (!exists(pnpm)) return [];
  return fs
    .readFileSync(pnpm, 'utf8')
    .split('\n')
    .map((line) => /^\s*-\s*["']?([^"'#]+)["']?\s*$/.exec(line)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

/** Only the `dir/*` shape real workspaces use; anything else is taken literally. */
function expandWorkspacePattern(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/\*\*$/, '/*');
  if (!clean.includes('*')) {
    const absolute = path.join(root, clean);
    return isDirectory(absolute) ? [absolute] : [];
  }
  const [prefix] = clean.split('*');
  const base = path.join(root, prefix ?? '');
  if (!isDirectory(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(base, entry.name))
    .filter((dir) => exists(path.join(dir, 'package.json')));
}

/** §12 — prefer `source` over build output, which may not exist. */
function workspaceSourceDir(root: string, dir: string, manifest: PackageJson): string {
  const declared = manifest.publishConfig?.source ?? manifest.source;
  if (declared) return toPosix(path.relative(root, path.dirname(path.join(dir, declared))));
  const src = path.join(dir, 'src');
  return toPosix(path.relative(root, isDirectory(src) ? src : dir));
}

function sourceRoots(
  root: string,
  routerRoot: string | null,
  workspaces: WorkspacePackage[],
): string[] {
  const roots = new Set<string>();
  const appDir = ['src', 'app', 'pages', 'components'].filter((dir) =>
    isDirectory(path.join(root, dir)),
  );
  if (appDir.length) appDir.forEach((dir) => roots.add(dir));
  else roots.add('.');
  if (routerRoot && isDirectory(path.join(root, routerRoot))) roots.add(routerRoot);
  workspaces.forEach((workspace) => roots.add(workspace.sourceDir));
  return dropNested([...roots].sort());
}

function dropNested(roots: readonly string[]): string[] {
  if (roots.includes('.')) return ['.'];
  return roots.filter(
    (candidate) => !roots.some((other) => other !== candidate && candidate.startsWith(`${other}/`)),
  );
}
