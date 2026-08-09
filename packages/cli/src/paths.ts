import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_DIRNAME, DOCUMENT_FILENAME } from '@jsxray/core';

const here = path.dirname(fileURLToPath(import.meta.url));

export function documentPath(outDir: string): string {
  return path.join(outDir, DOCUMENT_FILENAME);
}

export function assetDir(outDir: string): string {
  return path.join(outDir, ASSET_DIRNAME);
}

/** Works from `dist` and from `src` under tsx. */
export function viewerBundleDir(variant: 'dist' | 'dist-single'): string | null {
  let dir = here;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'packages', 'viewer', variant);
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export function packageVersion(): string {
  let dir = here;
  for (let depth = 0; depth < 4; depth++) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version ?? '0.0.0';
      } catch {
        return '0.0.0';
      }
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}
