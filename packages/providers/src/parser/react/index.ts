import fs from 'node:fs';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type {
  ComponentRecord,
  Diagnostic,
  FileExports,
  NavIntent,
  NavRecognizers,
  ParseInput,
  ParseOutput,
  ParserProvider,
  SourceLoc,
} from '@jsxray/core';
import { loadTsconfigPaths, resolveSpecifier, toRepoPath } from '../../module-resolution.js';

const traverse = ((traverseModule as unknown as { default?: unknown }).default ??
  traverseModule) as typeof import('@babel/traverse').default;

/** §11.1 — a page whose whole job is to redirect is still a component. */
const RENDER_NOTHING = new Set([
  'redirect',
  'notFound',
  'permanentRedirect',
  'forbidden',
  'unauthorized',
]);

const REEXPORT_PASS_CAP = 5;

interface FileAnalysis {
  file: string;
  absolute: string;
  components: ComponentRecord[];
  navIntents: NavIntent[];
  defaultComponentId: string | null;
  /** `export { default } from './x'` — folded to a fixed point later. */
  defaultFrom: string | null;
  starFrom: string[];
  named: Record<string, string>;
  /** §11.2 — local binding → where it came from, for resolving a wrapper. */
  imports: Record<string, ImportBinding>;
  forwarders: ForwarderCandidate[];
  pending: PendingIntent[];
}

interface ImportBinding {
  specifier: string;
  /** The name in the target module: a bare name, `default`, or `*`. */
  imported: string;
}

/**
 * §11.2 — `<LinkItem {...props}>` renders `<Link {...props}>`, so a target given
 * to `LinkItem` reaches `Link` untouched. The wrapper is a link by composition,
 * which is a fact about the code rather than a guess about its name.
 */
interface ForwarderCandidate {
  component: string;
  element: string;
}

/** A link-shaped element whose name is not yet known to be one. */
interface PendingIntent {
  element: string;
  intent: NavIntent;
}

export const reactParser: ParserProvider = {
  axis: 'parser',
  id: 'react',
  priority: 10,
  capabilities: { extensions: ['.tsx', '.jsx', '.ts', '.js', '.mts', '.mjs'], buildTree: false },

  supports: (profile) => profile.ui === 'react',

  /** §6.1 — neither JSX nor `export` means neither a component nor a re-export. */
  prefilter: (file, source) => {
    if (/\.d\.ts$/.test(file)) return false;
    return source.includes('export') || /<[A-Za-z/]/.test(source);
  },

  async parse(input: ParseInput): Promise<ParseOutput> {
    const diagnostics: Diagnostic[] = [];
    const tsconfig = loadTsconfigPaths(input.root);
    const context = { root: input.root, tsconfig, workspaces: input.profile.workspaces };
    const analyses: FileAnalysis[] = [];

    for (const absolute of input.files) {
      try {
        const source = fs.readFileSync(absolute, 'utf8');
        analyses.push(analyzeFile(absolute, source, input.root, input.recognizers));
      } catch (error) {
        diagnostics.push({
          level: 'warn',
          stage: 'parse',
          code: 'file-failed',
          message: messageOf(error),
          loc: { file: toRepoPath(input.root, absolute), line: 1, column: 0 },
        });
      }
    }

    const byAbsolute = new Map(analyses.map((analysis) => [analysis.absolute, analysis]));
    foldReExports(analyses, byAbsolute, context);
    promoteForwardedIntents(analyses, byAbsolute, context, input.recognizers);

    return {
      components: analyses.flatMap((analysis) => analysis.components),
      navIntents: analyses.flatMap((analysis) => analysis.navIntents),
      fileExports: analyses.map(
        (analysis): FileExports => ({
          file: analysis.file,
          defaultComponentId: analysis.defaultComponentId,
          named: analysis.named,
        }),
      ),
      diagnostics,
    };
  },
};

/** §11.1 — re-exports folded to a fixed point so a forwarding page resolves. */
function foldReExports(
  analyses: FileAnalysis[],
  byAbsolute: Map<string, FileAnalysis>,
  context: Parameters<typeof resolveSpecifier>[2],
): void {
  for (let pass = 0; pass < REEXPORT_PASS_CAP; pass++) {
    let changed = false;
    for (const analysis of analyses) {
      if (analysis.defaultComponentId) continue;
      const specifiers = [
        ...(analysis.defaultFrom ? [analysis.defaultFrom] : []),
        ...analysis.starFrom,
      ];
      for (const specifier of specifiers) {
        const resolved = resolveSpecifier(specifier, analysis.absolute, context);
        if (resolved.kind !== 'file') continue;
        const target = byAbsolute.get(resolved.file);
        if (!target?.defaultComponentId) continue;
        analysis.defaultComponentId = target.defaultComponentId;
        changed = true;
        break;
      }
    }
    if (!changed) return;
  }
}

/**
 * §11.2 — a wrapper is a link when it spreads its props into one, so the set of
 * link elements is a fixed point: `Link` seeds it, anything forwarding into a
 * member of it joins it, and a pending intent promotes once its element is in.
 */
function promoteForwardedIntents(
  analyses: FileAnalysis[],
  byAbsolute: Map<string, FileAnalysis>,
  context: Parameters<typeof resolveSpecifier>[2],
  recognizers: NavRecognizers,
): void {
  const builtin = new Set(recognizers.linkProps.map((recognizer) => recognizer.element));
  const links = new Set<string>();

  /** A stable key for what an element name refers to, or null when unresolvable. */
  const keyOf = (analysis: FileAnalysis, elementName: string): string | null => {
    const [root, ...rest] = elementName.split('.');
    if (!root) return null;
    if (!rest.length && builtin.has(root)) return `builtin:${root}`;

    const binding = analysis.imports[root];
    if (!binding) return rest.length ? null : `${analysis.absolute}::${root}`;

    const resolved = resolveSpecifier(binding.specifier, analysis.absolute, context);
    if (resolved.kind !== 'file') return null;
    const target = byAbsolute.get(resolved.file);
    if (!target) return null;

    // `* as NS` names the member; a named import names itself.
    const name =
      binding.imported === '*'
        ? rest[0]
        : binding.imported === 'default'
          ? target.defaultComponentId?.split('#').pop()
          : binding.imported;
    if (!name) return null;
    return `${target.absolute}::${target.named[name] ?? name}`;
  };

  for (let pass = 0; pass < REEXPORT_PASS_CAP; pass++) {
    let changed = false;
    for (const analysis of analyses) {
      for (const candidate of analysis.forwarders) {
        const self = `${analysis.absolute}::${candidate.component}`;
        if (links.has(self)) continue;
        const wraps = keyOf(analysis, candidate.element);
        if (!wraps || !(wraps.startsWith('builtin:') || links.has(wraps))) continue;
        links.add(self);
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const analysis of analyses) {
    for (const pending of analysis.pending) {
      const key = keyOf(analysis, pending.element);
      if (key && links.has(key)) analysis.navIntents.push(pending.intent);
    }
  }
}

function analyzeFile(
  absolute: string,
  source: string,
  root: string,
  recognizers: NavRecognizers,
): FileAnalysis {
  const file = toRepoPath(root, absolute);
  const ast = babelParse(source, {
    sourceType: 'module',
    errorRecovery: true,
    plugins: ['jsx', 'typescript', 'decorators-legacy'],
  });

  const analysis: FileAnalysis = {
    file,
    absolute,
    components: [],
    navIntents: [],
    defaultComponentId: null,
    defaultFrom: null,
    starFrom: [],
    named: {},
    imports: {},
    forwarders: [],
    pending: [],
  };

  const locOf = (node: t.Node): SourceLoc => ({
    file,
    line: node.loc?.start.line ?? 1,
    column: node.loc?.start.column ?? 0,
  });

  const componentRanges: { start: number; end: number; id: string }[] = [];
  const addComponent = (
    name: string,
    node: t.Node,
    kind: string,
    isPage: boolean,
  ): ComponentRecord => {
    const record: ComponentRecord = {
      id: `${file}#${name}`,
      name,
      file,
      loc: locOf(node),
      kind,
      isPage,
      renders: null,
      guards: null,
      props: null,
      designSystem: null,
    };
    if (!analysis.components.some((existing) => existing.id === record.id)) {
      analysis.components.push(record);
    }
    if (node.start != null && node.end != null) {
      componentRanges.push({ start: node.start, end: node.end, id: record.id });
    }
    return record;
  };

  traverse(ast, {
    ImportDeclaration(nodePath) {
      const specifier = nodePath.node.source.value;
      for (const imported of nodePath.node.specifiers) {
        if (t.isImportNamespaceSpecifier(imported)) {
          analysis.imports[imported.local.name] = { specifier, imported: '*' };
        } else if (t.isImportDefaultSpecifier(imported)) {
          analysis.imports[imported.local.name] = { specifier, imported: 'default' };
        } else if (t.isImportSpecifier(imported)) {
          analysis.imports[imported.local.name] = {
            specifier,
            imported: exportedName(imported.imported),
          };
        }
      }
    },

    ExportDefaultDeclaration(nodePath) {
      const resolved = resolveDefaultExport(nodePath.node.declaration, nodePath, absolute);
      if (!resolved) return;
      const record = addComponent(resolved.name, resolved.node, resolved.kind, true);
      analysis.defaultComponentId = record.id;
    },

    ExportNamedDeclaration(nodePath) {
      const { node } = nodePath;
      if (node.source) {
        for (const specifier of node.specifiers) {
          if (
            t.isExportSpecifier(specifier) &&
            exportedName(specifier.exported) === 'default'
          ) {
            analysis.defaultFrom = node.source.value;
          }
        }
        return;
      }
      for (const specifier of node.specifiers) {
        if (!t.isExportSpecifier(specifier)) continue;
        analysis.named[exportedName(specifier.exported)] = specifier.local.name;
      }
      if (t.isFunctionDeclaration(node.declaration) && node.declaration.id) {
        analysis.named[node.declaration.id.name] = node.declaration.id.name;
      }
      if (t.isVariableDeclaration(node.declaration)) {
        for (const declarator of node.declaration.declarations) {
          if (t.isIdentifier(declarator.id)) analysis.named[declarator.id.name] = declarator.id.name;
        }
      }
    },

    ExportAllDeclaration(nodePath) {
      analysis.starFrom.push(nodePath.node.source.value);
    },

    FunctionDeclaration(nodePath) {
      const name = nodePath.node.id?.name;
      if (name && isComponentName(name) && rendersSomething(nodePath.node)) {
        addComponent(name, nodePath.node, 'function', false);
      }
    },

    VariableDeclarator(nodePath) {
      const { id, init } = nodePath.node;
      if (!t.isIdentifier(id) || !init || !isComponentName(id.name)) return;
      const unwrapped = unwrapComponentWrapper(init);
      if (!unwrapped) return;
      if (!rendersSomething(unwrapped.node)) return;
      addComponent(id.name, nodePath.node, unwrapped.kind, false);
    },

    ClassDeclaration(nodePath) {
      const name = nodePath.node.id?.name;
      if (name && isComponentName(name) && extendsReactComponent(nodePath.node)) {
        addComponent(name, nodePath.node, 'class', false);
      }
    },
  });

  collectForwarders(ast, analysis);
  collectNavIntents(ast, source, recognizers, locOf, (node) => ownerOf(node, componentRanges), analysis);
  return analysis;
}

/**
 * §11.2 — a component that spreads its own rest props into a single JSX element
 * hands that element every prop it was given, target included. Record the pair;
 * whether the inner element is a link is settled later, across files.
 */
function collectForwarders(ast: t.File, analysis: FileAnalysis): void {
  const record = (name: string | undefined, fn: t.Function): void => {
    if (!name || !isComponentName(name)) return;
    const spread = spreadBindingOf(fn.params[0]);
    if (!spread) return;
    for (const element of elementsSpreading(fn, spread)) {
      analysis.forwarders.push({ component: name, element });
    }
  };

  traverse(ast, {
    FunctionDeclaration(nodePath) {
      record(nodePath.node.id?.name, nodePath.node);
    },
    VariableDeclarator(nodePath) {
      const { id, init } = nodePath.node;
      if (!t.isIdentifier(id) || !init) return;
      const unwrapped = unwrapComponentWrapper(init);
      if (!unwrapped || !t.isFunction(unwrapped.node)) return;
      record(id.name, unwrapped.node);
    },
  });
}

/** `({...props})` or `(props)` — the binding that carries everything not named. */
function spreadBindingOf(param: t.Node | undefined): string | null {
  if (!param) return null;
  if (t.isIdentifier(param)) return param.name;
  if (!t.isObjectPattern(param)) return null;
  for (const property of param.properties) {
    if (t.isRestElement(property) && t.isIdentifier(property.argument)) {
      return property.argument.name;
    }
  }
  return null;
}

function elementsSpreading(fn: t.Function, binding: string): string[] {
  const names: string[] = [];
  t.traverseFast(fn as t.Node, (node) => {
    if (!t.isJSXOpeningElement(node)) return;
    const spreads = node.attributes.some(
      (attribute) =>
        t.isJSXSpreadAttribute(attribute) &&
        t.isIdentifier(attribute.argument) &&
        attribute.argument.name === binding,
    );
    if (spreads) names.push(jsxName(node.name));
  });
  return names;
}

interface ResolvedDefault {
  name: string;
  node: t.Node;
  kind: string;
}

function resolveDefaultExport(
  declaration: t.Node,
  nodePath: NodePath<t.ExportDefaultDeclaration>,
  absolute: string,
): ResolvedDefault | null {
  const fallbackName = nameFromFile(absolute);

  if (t.isFunctionDeclaration(declaration)) {
    if (!rendersSomething(declaration)) return null;
    return { name: declaration.id?.name ?? fallbackName, node: declaration, kind: 'function' };
  }

  if (t.isClassDeclaration(declaration)) {
    if (!extendsReactComponent(declaration)) return null;
    return { name: declaration.id?.name ?? fallbackName, node: declaration, kind: 'class' };
  }

  if (t.isIdentifier(declaration)) {
    const binding = nodePath.scope.getBinding(declaration.name);
    const bound = binding?.path.node;
    if (!bound) return null;
    if (t.isVariableDeclarator(bound) && bound.init) {
      const unwrapped = unwrapComponentWrapper(bound.init);
      if (!unwrapped || !rendersSomething(unwrapped.node)) return null;
      return { name: declaration.name, node: bound, kind: unwrapped.kind };
    }
    if (t.isFunctionDeclaration(bound) && rendersSomething(bound)) {
      return { name: declaration.name, node: bound, kind: 'function' };
    }
    if (t.isClassDeclaration(bound) && extendsReactComponent(bound)) {
      return { name: declaration.name, node: bound, kind: 'class' };
    }
    return null;
  }

  if (t.isExpression(declaration)) {
    const unwrapped = unwrapComponentWrapper(declaration);
    if (!unwrapped || !rendersSomething(unwrapped.node)) return null;
    return {
      name: fallbackName,
      node: declaration,
      kind: unwrapped.kind === 'function' ? 'anonymous' : unwrapped.kind,
    };
  }

  return null;
}

function unwrapComponentWrapper(node: t.Node): { node: t.Node; kind: string } | null {
  if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
    return { node, kind: 'function' };
  }
  if (t.isCallExpression(node)) {
    const callee = calleeName(node.callee);
    if (callee === 'memo' || callee === 'React.memo') {
      const inner = node.arguments[0];
      return inner && t.isExpression(inner) ? { node: inner, kind: 'memo' } : null;
    }
    if (callee === 'forwardRef' || callee === 'React.forwardRef') {
      const inner = node.arguments[0];
      return inner && t.isExpression(inner) ? { node: inner, kind: 'forwardRef' } : null;
    }
  }
  return null;
}

function rendersSomething(node: t.Node): boolean {
  let found = false;
  const check = (child: t.Node | null | undefined): void => {
    if (!child || found) return;
    if (t.isJSXElement(child) || t.isJSXFragment(child)) {
      found = true;
      return;
    }
    if (t.isCallExpression(child)) {
      const callee = calleeName(child.callee);
      if (callee && RENDER_NOTHING.has(callee.split('.').pop()!)) {
        found = true;
        return;
      }
    }
    for (const key of t.VISITOR_KEYS[child.type] ?? []) {
      const value = (child as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) value.forEach((item) => check(item as t.Node));
      else if (value && typeof value === 'object') check(value as t.Node);
    }
  };
  check(node);
  return found;
}

function extendsReactComponent(node: t.ClassDeclaration | t.ClassExpression): boolean {
  const superClass = node.superClass;
  if (!superClass) return false;
  const name = calleeName(superClass);
  return name === 'Component' || name === 'PureComponent' || /\.(Pure)?Component$/.test(name ?? '');
}

/* ── nav intents (§11.2) ──────────────────────────────────────────────────── */

function collectNavIntents(
  ast: t.File,
  source: string,
  recognizers: NavRecognizers,
  locOf: (node: t.Node) => SourceLoc,
  ownerOf: (node: t.Node) => string | null,
  analysis: FileAnalysis,
): void {
  const textOf = (node: t.Node): string =>
    node.start != null && node.end != null ? source.slice(node.start, node.end) : '';

  traverse(ast, {
    JSXOpeningElement(nodePath) {
      const elementName = jsxName(nodePath.node.name);
      const known = recognizers.linkProps.some(
        (recognizer) => recognizer.element === elementName,
      );

      // An unrecognized element carrying a link prop is only a candidate: it is
      // a link if it forwards into one, which takes every file to decide (§11.2).
      const props = new Set(
        recognizers.linkProps
          .filter((recognizer) => !known || recognizer.element === elementName)
          .map((recognizer) => recognizer.prop),
      );

      for (const prop of props) {
        const attribute = nodePath.node.attributes.find(
          (candidate): candidate is t.JSXAttribute =>
            t.isJSXAttribute(candidate) && jsxName(candidate.name) === prop,
        );
        if (!attribute) continue;

        const parent = nodePath.parentPath.node;
        const intent: NavIntent = {
          kind: 'link',
          target: literalOfAttribute(attribute),
          targetExpression: expressionOfAttribute(attribute, textOf),
          trigger: t.isJSXElement(parent) ? jsxText(parent) : null,
          componentId: ownerOf(nodePath.node),
          loc: locOf(nodePath.node),
        };

        if (known) analysis.navIntents.push(intent);
        else analysis.pending.push({ element: elementName, intent });
      }
    },

    CallExpression(nodePath) {
      const callee = calleeName(nodePath.node.callee);
      if (!callee) return;
      const recognizer = recognizers.calls.find(
        (candidate) => candidate.callee === callee || callee.endsWith(`.${candidate.callee}`),
      );
      if (!recognizer) return;

      const argument = nodePath.node.arguments[recognizer.target.arg];
      if (!argument) return;

      const { target, targetExpression } = readCallTarget(argument, recognizer.target.key, textOf);
      analysis.navIntents.push({
        kind: recognizer.kind,
        target,
        targetExpression,
        trigger: null,
        componentId: ownerOf(nodePath.node),
        loc: locOf(nodePath.node),
      });
    },
  });
}

function readCallTarget(
  argument: t.Node,
  key: string | undefined,
  textOf: (node: t.Node) => string,
): { target: string | null; targetExpression: string | null } {
  if (key && t.isObjectExpression(argument)) {
    const property = argument.properties.find(
      (candidate): candidate is t.ObjectProperty =>
        t.isObjectProperty(candidate) &&
        (t.isIdentifier(candidate.key) ? candidate.key.name : null) === key,
    );
    if (!property) return { target: null, targetExpression: textOf(argument) };
    if (t.isStringLiteral(property.value)) return { target: property.value.value, targetExpression: null };
    return { target: null, targetExpression: textOf(property.value) };
  }
  if (t.isStringLiteral(argument)) return { target: argument.value, targetExpression: null };
  return { target: null, targetExpression: textOf(argument) };
}

function literalOfAttribute(attribute: t.JSXAttribute): string | null {
  if (t.isStringLiteral(attribute.value)) return attribute.value.value;
  if (
    t.isJSXExpressionContainer(attribute.value) &&
    t.isStringLiteral(attribute.value.expression)
  ) {
    return attribute.value.expression.value;
  }
  return null;
}

function expressionOfAttribute(
  attribute: t.JSXAttribute,
  textOf: (node: t.Node) => string,
): string | null {
  if (!t.isJSXExpressionContainer(attribute.value)) return null;
  if (t.isStringLiteral(attribute.value.expression)) return null;
  return textOf(attribute.value.expression);
}

function jsxText(element: t.JSXElement): string | null {
  const text = element.children
    .map((child) => (t.isJSXText(child) ? child.value : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length ? text : null;
}

function ownerOf(node: t.Node, ranges: { start: number; end: number; id: string }[]): string | null {
  if (node.start == null || node.end == null) return null;
  let best: { start: number; end: number; id: string } | null = null;
  for (const range of ranges) {
    if (range.start <= node.start && range.end >= node.end) {
      if (!best || range.end - range.start < best.end - best.start) best = range;
    }
  }
  return best?.id ?? null;
}

/* ── small helpers ────────────────────────────────────────────────────────── */

function calleeName(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node)) {
    const object = calleeName(node.object);
    const property = t.isIdentifier(node.property) ? node.property.name : null;
    return object && property ? `${object}.${property}` : property;
  }
  if (t.isCallExpression(node)) return calleeName(node.callee);
  return null;
}

function jsxName(node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(node)) return node.name;
  if (t.isJSXNamespacedName(node)) return `${node.namespace.name}:${node.name.name}`;
  return `${jsxName(node.object)}.${node.property.name}`;
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function nameFromFile(absolute: string): string {
  const base = path.basename(absolute).replace(/\.[^.]+$/, '');
  const name = base === 'index' ? path.basename(path.dirname(absolute)) : base;
  return (
    name
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('') || 'Default'
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
