import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from './jsonc.js';

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function readJson<T = unknown>(file: string): T | null {
  try {
    return parseJsonc<T>(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function firstExisting(root: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (exists(path.join(root, candidate))) return candidate;
  }
  return null;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.expo',
  '.jsxray',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.output',
  '.svelte-kit',
]);

export interface WalkOptions {
  extensions?: readonly string[];
  maxFiles?: number;
}

export function walkFiles(dir: string, options: WalkOptions = {}): string[] {
  const extensions = options.extensions ? new Set(options.extensions) : null;
  const maxFiles = options.maxFiles ?? 50_000;
  const found: string[] = [];

  const visit = (current: string): void => {
    if (found.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        if (extensions && !extensions.has(path.extname(entry.name))) continue;
        found.push(full);
      }
    }
  };

  if (isDirectory(dir)) visit(dir);
  return found;
}
