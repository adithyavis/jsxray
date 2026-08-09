import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, toPosix, type WorkspacePackage } from '@jsxray/core';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.mts', '.cts'];

export interface TsconfigPaths {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

interface TsconfigFile {
  extends?: string;
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

export function loadTsconfigPaths(root: string): TsconfigPaths {
  const seen = new Set<string>();
  const result: TsconfigPaths = { baseUrl: null, paths: {} };

  const visit = (file: string): void => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    let config: TsconfigFile;
    try {
      config = parseJsonc<TsconfigFile>(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (config.extends) {
      const parent = config.extends.startsWith('.')
        ? path.resolve(path.dirname(file), config.extends)
        : path.join(root, 'node_modules', config.extends);
      visit(parent.endsWith('.json') ? parent : `${parent}.json`);
    }
    const dir = path.dirname(file);
    if (config.compilerOptions?.baseUrl) {
      result.baseUrl = path.resolve(dir, config.compilerOptions.baseUrl);
    }
    for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths ?? {})) {
      result.paths[pattern] = targets.map((target) => path.resolve(result.baseUrl ?? dir, target));
    }
  };

  visit(path.join(root, 'tsconfig.json'));
  visit(path.join(root, 'jsconfig.json'));
  return result;
}

export interface ResolveContext {
  root: string;
  tsconfig: TsconfigPaths;
  workspaces: WorkspacePackage[];
}

export type Resolution =
  | { kind: 'file'; file: string }
  | { kind: 'package'; name: string }
  | { kind: 'unresolved' };

export function resolveSpecifier(
  specifier: string,
  importer: string,
  context: ResolveContext,
): Resolution {
  if (specifier.startsWith('.')) {
    const file = resolveFile(path.resolve(path.dirname(importer), specifier));
    return file ? { kind: 'file', file } : { kind: 'unresolved' };
  }

  const workspace = matchWorkspace(specifier, context.workspaces);
  if (workspace) {
    const subpath = specifier.slice(workspace.name.length).replace(/^\//, '');
    const base = path.join(context.root, workspace.sourceDir);
    const file = resolveFile(subpath ? path.join(base, subpath) : base);
    if (file) return { kind: 'file', file };
  }

  const aliased = resolveTsconfigPath(specifier, context.tsconfig);
  if (aliased) return { kind: 'file', file: aliased };

  if (context.tsconfig.baseUrl) {
    const file = resolveFile(path.join(context.tsconfig.baseUrl, specifier));
    if (file) return { kind: 'file', file };
  }

  return { kind: 'package', name: packageNameOf(specifier) };
}

function matchWorkspace(
  specifier: string,
  workspaces: readonly WorkspacePackage[],
): WorkspacePackage | null {
  return (
    workspaces.find(
      (workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`),
    ) ?? null
  );
}

/** Longest pattern first (§12). */
function resolveTsconfigPath(specifier: string, tsconfig: TsconfigPaths): string | null {
  const patterns = Object.keys(tsconfig.paths).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern !== specifier) continue;
      for (const target of tsconfig.paths[pattern]!) {
        const file = resolveFile(target);
        if (file) return file;
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of tsconfig.paths[pattern]!) {
      const file = resolveFile(target.replace('*', middle));
      if (file) return file;
    }
  }
  return null;
}

/** A `.js` specifier resolves to its `.ts`/`.tsx` source — the NodeNext convention. */
const REWRITABLE = new Set(['.js', '.jsx', '.mjs', '.cjs']);

export function resolveFile(candidate: string): string | null {
  if (isFile(candidate) && EXTENSIONS.includes(path.extname(candidate))) return candidate;
  for (const extension of EXTENSIONS) {
    const withExtension = `${candidate}${extension}`;
    if (isFile(withExtension)) return withExtension;
  }
  const extension = path.extname(candidate);
  if (REWRITABLE.has(extension)) {
    const stripped = candidate.slice(0, -extension.length);
    for (const replacement of EXTENSIONS) {
      const rewritten = `${stripped}${replacement}`;
      if (isFile(rewritten)) return rewritten;
    }
  }
  for (const indexExtension of EXTENSIONS) {
    const index = path.join(candidate, `index${indexExtension}`);
    if (isFile(index)) return index;
  }
  return null;
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

export function toRepoPath(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}
