import path from 'node:path';

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function repoRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return toPosix(absolute);
  return toPosix(relative);
}

export function documentRelative(outDir: string, absolute: string): string {
  return toPosix(path.relative(outDir, absolute));
}

export function slugForFile(signature: string): string {
  const slug = signature
    .replace(/^\//, '')
    .replace(/[/\\]/g, '__')
    .replace(/[^a-zA-Z0-9._$#-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length ? slug.slice(0, 120) : 'root';
}

export function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}
