import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import { walkFiles, type FrameworkProfile } from '@jsxray/core';
import { loadTsconfigPaths, resolveSpecifier, type ResolveContext } from '../module-resolution.js';

export const traverse = ((traverseModule as unknown as { default?: unknown }).default ??
  traverseModule) as typeof import('@babel/traverse').default;

const EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mts', '.mjs'];

/** Barrels chain, but not forever; past this it is a cycle, not a re-export. */
const BARREL_HOPS = 5;

/** §4 — shared by the two `config` strategy routers (§13.1, §13.2). */
export interface SourceFile {
  absolute: string;
  source: string;
  ast: t.File;
}

export interface ScanContext {
  root: string;
  resolve: ResolveContext;
  /** Parsed modules, keyed absolute — a constants file is read once per run. */
  modules: Map<string, ModuleTables | null>;
}

export function createScanContext(root: string, profile: FrameworkProfile): ScanContext {
  return {
    root,
    resolve: { root, tsconfig: loadTsconfigPaths(root), workspaces: profile.workspaces },
    modules: new Map(),
  };
}

export function parseSource(source: string): t.File | null {
  try {
    return babelParse(source, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: ['jsx', 'typescript', 'decorators-legacy'],
    });
  } catch {
    return null;
  }
}

/** Prefiltered: without it a config router re-parses the whole repo (§6.1). */
export function scanSources(
  root: string,
  profile: FrameworkProfile,
  isCandidate: (source: string) => boolean,
): SourceFile[] {
  const found: SourceFile[] = [];
  const seen = new Set<string>();

  for (const sourceRoot of profile.sourceRoots) {
    for (const absolute of walkFiles(path.join(root, sourceRoot), { extensions: EXTENSIONS })) {
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (/\.d\.ts$/.test(absolute)) continue;
      let source: string;
      try {
        source = fs.readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      if (!isCandidate(source)) continue;
      const ast = parseSource(source);
      if (ast) found.push({ absolute, source, ast });
    }
  }

  return found;
}

/* ── constants ────────────────────────────────────────────────────────────── */

interface ImportBinding {
  specifier: string;
  /** The name in the exporting module: a named export, or `default`. */
  imported: string;
}

export interface ModuleTables {
  strings: Map<string, string>;
  objects: Map<string, Map<string, string>>;
  imports: Map<string, ImportBinding>;
  /** `export default { … }` or `export default ROUTES`. */
  defaultObject: Map<string, string> | null;
  /** `export { X } from './y'` — exported name to where it really lives. */
  reexports: Map<string, ImportBinding>;
  /** `export const X = lazy(() => import('./y'))` — exported name to specifier. */
  lazy: Map<string, string>;
}

/** Top level only — a route table is a module constant by convention. */
export function readModuleTables(ast: t.File): ModuleTables {
  const tables: ModuleTables = {
    strings: new Map(),
    objects: new Map(),
    imports: new Map(),
    defaultObject: null,
    reexports: new Map(),
    lazy: new Map(),
  };

  const record = (declaration: t.VariableDeclaration, exported: boolean): void => {
    for (const declarator of declaration.declarations) {
      if (!t.isIdentifier(declarator.id) || !declarator.init) continue;
      const init = unwrapAs(declarator.init);
      if (t.isStringLiteral(init)) tables.strings.set(declarator.id.name, init.value);
      else if (t.isObjectExpression(init)) {
        tables.objects.set(declarator.id.name, stringProperties(init));
      }
      if (!exported) continue;
      const specifier = dynamicImportSpecifier(init);
      if (specifier) tables.lazy.set(declarator.id.name, specifier);
    }
  };

  for (const statement of ast.program.body) {
    if (t.isVariableDeclaration(statement)) {
      record(statement, false);
      continue;
    }

    if (t.isImportDeclaration(statement)) {
      for (const specifier of statement.specifiers) {
        if (t.isImportDefaultSpecifier(specifier)) {
          tables.imports.set(specifier.local.name, {
            specifier: statement.source.value,
            imported: 'default',
          });
        } else if (t.isImportSpecifier(specifier)) {
          tables.imports.set(specifier.local.name, {
            specifier: statement.source.value,
            imported: t.isIdentifier(specifier.imported)
              ? specifier.imported.name
              : specifier.imported.value,
          });
        } else if (t.isImportNamespaceSpecifier(specifier)) {
          tables.imports.set(specifier.local.name, {
            specifier: statement.source.value,
            imported: 'default',
          });
        }
      }
      continue;
    }

    if (t.isExportNamedDeclaration(statement)) {
      if (t.isVariableDeclaration(statement.declaration)) {
        record(statement.declaration, true);
        continue;
      }
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (!t.isExportSpecifier(specifier)) continue;
          tables.reexports.set(exportedName(specifier.exported), {
            specifier: statement.source.value,
            imported: specifier.local.name,
          });
        }
      }
      continue;
    }

    if (t.isExportDefaultDeclaration(statement)) {
      const declaration = unwrapAs(statement.declaration);
      if (t.isObjectExpression(declaration)) {
        tables.defaultObject = stringProperties(declaration);
      } else if (t.isIdentifier(declaration)) {
        // Resolved after the loop; the binding may be declared further up.
        tables.defaultObject = tables.objects.get(declaration.name) ?? null;
        if (!tables.defaultObject) {
          tables.strings.set('__default__', declaration.name);
        }
      }
    }
  }

  // `const ROUTES = {…}` below `export default ROUTES` is legal; resolve late.
  const deferred = tables.strings.get('__default__');
  if (deferred) {
    tables.defaultObject = tables.objects.get(deferred) ?? null;
    tables.strings.delete('__default__');
  }

  return tables;
}

function stringProperties(node: t.ObjectExpression): Map<string, string> {
  const map = new Map<string, string>();
  for (const property of node.properties) {
    if (!t.isObjectProperty(property)) continue;
    const key = propertyKey(property);
    if (!key) continue;
    const value = unwrapAs(property.value);
    if (t.isStringLiteral(value)) map.set(key, value.value);
    else if (t.isTemplateLiteral(value) && !value.expressions.length) {
      map.set(key, value.quasis.map((quasi) => quasi.value.cooked ?? '').join(''));
    }
  }
  return map;
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

/** Both Babel 8 `ImportExpression` and the Babel 7 `Import` callee shape. */
export function dynamicImportSpecifier(node: t.Node): string | null {
  let found: string | null = null;
  const visit = (child: t.Node | null | undefined): void => {
    if (!child || found) return;
    if (t.isImportExpression(child)) {
      if (t.isStringLiteral(child.source)) found = child.source.value;
      return;
    }
    if (t.isCallExpression(child) && child.callee.type === ('Import' as string)) {
      const argument = child.arguments[0];
      if (argument && t.isStringLiteral(argument)) found = argument.value;
      return;
    }
    for (const key of t.VISITOR_KEYS[child.type] ?? []) {
      const value = (child as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) value.forEach((item) => visit(item as t.Node));
      else if (value && typeof value === 'object') visit(value as t.Node);
    }
  };
  visit(node);
  return found;
}

export function propertyKey(property: t.ObjectProperty | t.ObjectMethod): string | null {
  if (t.isIdentifier(property.key) && !property.computed) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

/** `x as const` / `x satisfies T` wrap the value the author meant. */
function unwrapAs(node: t.Node): t.Node {
  let current = node;
  while (
    t.isTSAsExpression(current) ||
    t.isTSSatisfiesExpression(current) ||
    t.isTSNonNullExpression(current) ||
    t.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** §13.1 — resolves `path: ROUTES.SIGN_UP` across modules, not just literals. */
export class Constants {
  private readonly tables: ModuleTables;

  constructor(
    private readonly context: ScanContext,
    private readonly absolute: string,
    ast: t.File,
  ) {
    this.tables = readModuleTables(ast);
  }

  string(node: t.Node | null | undefined): string | null {
    if (!node) return null;
    const value = unwrapAs(node);

    if (t.isStringLiteral(value)) return value.value;

    if (t.isTemplateLiteral(value)) {
      if (value.expressions.length) return null;
      return value.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
    }

    if (t.isIdentifier(value)) {
      const local = this.tables.strings.get(value.name);
      if (local !== undefined) return local;
      return this.importedString(value.name);
    }

    if (t.isMemberExpression(value) && !value.computed) {
      const property = t.isIdentifier(value.property) ? value.property.name : null;
      if (!property || !t.isIdentifier(value.object)) return null;
      return this.object(value.object.name)?.get(property) ?? null;
    }

    if (t.isBinaryExpression(value) && value.operator === '+') {
      const left = t.isExpression(value.left) ? this.string(value.left) : null;
      const right = this.string(value.right);
      return left !== null && right !== null ? left + right : null;
    }

    return null;
  }

  /** Every string value of an object constant, keyed by property. */
  object(name: string): Map<string, string> | null {
    const local = this.tables.objects.get(name);
    if (local) return local;

    const binding = this.tables.imports.get(name);
    if (!binding) return null;
    const target = this.load(binding.specifier);
    if (!target) return null;
    return binding.imported === 'default'
      ? target.defaultObject
      : (target.objects.get(binding.imported) ?? null);
  }

  private importedString(name: string): string | null {
    const binding = this.tables.imports.get(name);
    if (!binding) return null;
    const target = this.load(binding.specifier);
    if (!target) return null;
    return binding.imported === 'default' ? null : (target.strings.get(binding.imported) ?? null);
  }

  private load(specifier: string): ModuleTables | null {
    const resolved = resolveSpecifier(specifier, this.absolute, this.context.resolve);
    return resolved.kind === 'file' ? this.tablesOf(resolved.file) : null;
  }

  /** §13.1 — the defining module, not the barrel the route imports from. */
  fileOf(name: string): string | null {
    const binding = this.tables.imports.get(name);
    if (!binding) return null;
    const resolved = resolveSpecifier(binding.specifier, this.absolute, this.context.resolve);
    if (resolved.kind !== 'file') return null;
    return this.followExport(resolved.file, binding.imported);
  }

  /** The name an imported local carries in the module that exports it. */
  exportedNameOf(local: string): string | null {
    return this.tables.imports.get(local)?.imported ?? null;
  }

  fileOfSpecifier(specifier: string): string | null {
    const resolved = resolveSpecifier(specifier, this.absolute, this.context.resolve);
    return resolved.kind === 'file' ? resolved.file : null;
  }

  /** Follows re-exports and lazy imports to the module that defines the export. */
  private followExport(file: string, exported: string): string {
    let current = file;
    let name = exported;

    for (let hop = 0; hop < BARREL_HOPS; hop++) {
      const tables = this.tablesOf(current);
      if (!tables) return current;

      const lazy = tables.lazy.get(name);
      if (lazy) {
        const resolved = resolveSpecifier(lazy, current, this.context.resolve);
        return resolved.kind === 'file' ? resolved.file : current;
      }

      const reexport = tables.reexports.get(name);
      if (!reexport) return current;
      const resolved = resolveSpecifier(reexport.specifier, current, this.context.resolve);
      if (resolved.kind !== 'file') return current;
      current = resolved.file;
      name = reexport.imported === 'default' ? 'default' : reexport.imported;
    }

    return current;
  }

  private tablesOf(file: string): ModuleTables | null {
    const cached = this.context.modules.get(file);
    if (cached !== undefined) return cached;
    let tables: ModuleTables | null = null;
    try {
      const ast = parseSource(fs.readFileSync(file, 'utf8'));
      if (ast) tables = readModuleTables(ast);
    } catch {
      tables = null;
    }
    this.context.modules.set(file, tables);
    return tables;
  }
}

/* ── path normalisation ───────────────────────────────────────────────────── */

/** §13.1 — library route syntax reduced to §3's canonical form. */
export function normalizeConfigPath(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // A query belongs to the link, not the route.
  const query = value.indexOf('?');
  if (query !== -1 && /^[^/]*=/.test(value.slice(query + 1))) value = value.slice(0, query);
  value = value.split('#')[0]!;

  value = stripParenGroups(value);

  const segments: string[] = [];
  for (const raw of value.split('/')) {
    const segment = raw.trim();
    if (!segment) continue;
    if (segment === '*' || segment === '**') {
      segments.push('*splat');
      continue;
    }
    if (segment.startsWith(':')) {
      // §13.1 — modifiers dropped; the parameter is recorded as required.
      const name = segment.slice(1).replace(/[?+*]+$/, '');
      if (name) segments.push(`:${name}`);
      continue;
    }
    segments.push(segment.replace(/\?$/, ''));
  }

  return segments.length ? `/${segments.join('/')}` : '/';
}

/** react-router v5 constrains a param with a regex: `/:team(\w+)` → `/:team`. */
function stripParenGroups(value: string): string {
  let depth = 0;
  let out = '';
  for (const character of value) {
    if (character === '(') {
      depth++;
      continue;
    }
    if (character === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += character;
  }
  return out;
}

/** Joins a nested child path onto its parent, honouring absolute children. */
export function joinConfigPath(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  if (!parent || parent === '/') return `/${child}`;
  return `${parent.replace(/\/$/, '')}/${child}`;
}
