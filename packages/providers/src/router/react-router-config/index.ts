import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  routeParams,
  type Diagnostic,
  type EnumerateInput,
  type EnumerateOutput,
  type RouterProvider,
} from '@jsxray/core';
import { buildCandidateEdges, buildScreens, type ScreenDraft } from '../shared.js';
import {
  Constants,
  createScanContext,
  dynamicImportSpecifier,
  joinConfigPath,
  normalizeConfigPath,
  propertyKey,
  scanSources,
  traverse,
  type SourceFile,
} from '../config-scan.js';
import { reactRouterRecognizers } from '../react-router/index.js';

/** Keys that mark an object literal as a route rather than any object with a path. */
const ROUTE_KEYS = ['element', 'Component', 'component', 'lazy', 'children', 'index', 'handle'];

const ROUTER_CALLS =
  /createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes|createRoutesFromChildren/;

/** Route nesting deeper than this is a cycle in something, not a route tree. */
const NESTING_CAP = 20;

/** §13.1 — route object arrays and JSX `<Route>` trees; an app may have both. */
export const reactRouterConfigRouter: RouterProvider = {
  axis: 'router',
  id: 'react-router-config',
  priority: 14,
  capabilities: { discovery: ['config'] },
  recognizers: reactRouterRecognizers,

  supports: (profile) => profile.router === 'react-router-config',

  async enumerate(input: EnumerateInput): Promise<EnumerateOutput> {
    const diagnostics: Diagnostic[] = [];
    const context = createScanContext(input.root, input.profile);
    const files = scanSources(input.root, input.profile, isCandidate);

    const drafts: ScreenDraft[] = [];
    let unresolved = 0;

    for (const file of files) {
      const constants = new Constants(context, file.absolute, file.ast);
      const found = readRoutes(file, constants);
      drafts.push(...found.drafts);
      unresolved += found.unresolved;
    }

    if (!drafts.length) {
      return {
        screens: [],
        edges: [],
        strategy: 'config',
        diagnostics: [
          {
            level: 'warn',
            stage: 'enumerate',
            code: 'no-route-config',
            message:
              'react-router detected in config mode but no route table was found; looked for route object arrays and <Route> trees',
          },
        ],
      };
    }

    if (unresolved) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'computed-route-path',
        message: `${unresolved} route paths are computed at runtime and could not be read statically`,
      });
    }

    const screens = buildScreens(input.root, dedupe(drafts), input.fileExports);
    const { edges, unattributed } = buildCandidateEdges(input.root, screens, input.navIntents);
    if (unattributed) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'unattributed-intents',
        message: `${unattributed} nav intents live in shared components and belong to no single screen`,
      });
    }

    return { screens, edges, strategy: 'config', diagnostics };
  },
};

function isCandidate(source: string): boolean {
  if (ROUTER_CALLS.test(source)) return true;
  if (/<Route[\s/>]/.test(source)) return true;
  // A hand-rolled `RouteProps[]` table: react-router imported, and paths declared.
  return /from\s+['"]react-router(-dom)?['"]/.test(source) && /\bpath\s*:/.test(source);
}

interface Found {
  drafts: ScreenDraft[];
  unresolved: number;
}

function readRoutes(file: SourceFile, constants: Constants): Found {
  const drafts: ScreenDraft[] = [];
  let unresolved = 0;

  const push = (route: string, pattern: string, absolute: string | null): void => {
    drafts.push({
      route,
      pattern,
      kind: 'page',
      isPage: true,
      absolute,
      meta: { groups: [], dynamic: routeParams(route).length > 0, params: routeParams(route) },
    });
  };

  traverse(file.ast, {
    // v6: { path: '/x', element: <X/>, children: [...] }
    ObjectExpression(nodePath) {
      if (!isRouteObject(nodePath.node)) return;
      const raw = rawPathOf(nodePath.node, constants);
      const indexRoute = isIndexRoute(nodePath.node);
      if (raw === null && !indexRoute) {
        if (hasPathProperty(nodePath.node)) unresolved++;
        return;
      }

      const prefix = objectPrefix(nodePath, constants);
      const joined = raw === null ? prefix || '/' : joinConfigPath(prefix, raw);
      const route = normalizeConfigPath(joined);
      if (!route) return;
      push(route, raw ?? '(index)', componentFileOfObject(nodePath.node, constants));
    },

    // v5 and v6 JSX: <Route path="/x" component={X} />
    JSXOpeningElement(nodePath) {
      if (!isRouteElement(nodePath.node)) return;
      const attribute = pathAttribute(nodePath.node);
      if (!attribute) return;
      const raw = constants.string(valueOfAttribute(attribute));
      if (raw === null) {
        unresolved++;
        return;
      }

      const prefix = jsxPrefix(nodePath, constants);
      const route = normalizeConfigPath(joinConfigPath(prefix, raw));
      if (!route) return;
      push(route, raw, componentFileOfElement(nodePath.node, constants));
    },
  });

  return { drafts, unresolved };
}

/* ── route objects ────────────────────────────────────────────────────────── */

function isRouteObject(node: t.ObjectExpression): boolean {
  const keys = new Set(
    node.properties
      .filter((property): property is t.ObjectProperty => t.isObjectProperty(property))
      .map((property) => propertyKey(property))
      .filter((key): key is string => key !== null),
  );
  if (!keys.has('path') && !keys.has('index')) return false;
  return ROUTE_KEYS.some((key) => keys.has(key));
}

function hasPathProperty(node: t.ObjectExpression): boolean {
  return node.properties.some(
    (property) => t.isObjectProperty(property) && propertyKey(property) === 'path',
  );
}

function isIndexRoute(node: t.ObjectExpression): boolean {
  const property = findProperty(node, 'index');
  return !!property && t.isBooleanLiteral(property.value) && property.value.value;
}

function rawPathOf(node: t.ObjectExpression, constants: Constants): string | null {
  const property = findProperty(node, 'path');
  return property ? constants.string(property.value) : null;
}

function findProperty(node: t.ObjectExpression, name: string): t.ObjectProperty | null {
  return (
    node.properties.find(
      (property): property is t.ObjectProperty =>
        t.isObjectProperty(property) && propertyKey(property) === name,
    ) ?? null
  );
}

/** Walks out through the `children` array to the parent route object. */
function objectPrefix(nodePath: NodePath<t.ObjectExpression>, constants: Constants): string {
  const parts: string[] = [];
  let current: NodePath<t.ObjectExpression> = nodePath;

  for (let depth = 0; depth < NESTING_CAP; depth++) {
    const array = current.parentPath;
    if (!array?.isArrayExpression()) break;
    const property = array.parentPath;
    if (!property?.isObjectProperty() || propertyKey(property.node) !== 'children') break;
    const owner = property.parentPath;
    if (!owner.isObjectExpression()) break;

    const raw = rawPathOf(owner.node, constants);
    if (raw) parts.unshift(raw);
    current = owner;
  }

  return parts.reduce<string>((prefix, part) => joinConfigPath(prefix, part), '');
}

function componentFileOfObject(node: t.ObjectExpression, constants: Constants): string | null {
  for (const key of ['Component', 'component']) {
    const property = findProperty(node, key);
    if (property && t.isIdentifier(property.value)) {
      const file = constants.fileOf(property.value.name);
      if (file) return file;
    }
  }

  const element = findProperty(node, 'element');
  if (element && t.isJSXElement(element.value)) {
    const file = componentFileOfElement(element.value.openingElement, constants);
    if (file) return file;
  }

  const lazy = findProperty(node, 'lazy');
  if (lazy) {
    const specifier = dynamicImportSpecifier(lazy.value);
    if (specifier) return constants.fileOfSpecifier(specifier);
  }

  return null;
}

/* ── JSX routes ───────────────────────────────────────────────────────────── */

/** §13.1 — `<Route>` and the guard wrappers (`<HFRoute>`, `<PrivateRoute>`). */
const ROUTE_ELEMENT = /(?:^|\.)[A-Za-z]*Route$/;

function isRouteElement(node: t.JSXOpeningElement): boolean {
  return ROUTE_ELEMENT.test(jsxName(node.name));
}

function pathAttribute(node: t.JSXOpeningElement): t.JSXAttribute | null {
  return (
    node.attributes.find(
      (attribute): attribute is t.JSXAttribute =>
        t.isJSXAttribute(attribute) && jsxAttributeName(attribute) === 'path',
    ) ?? null
  );
}

function valueOfAttribute(attribute: t.JSXAttribute): t.Node | null {
  if (!attribute.value) return null;
  if (t.isStringLiteral(attribute.value)) return attribute.value;
  if (t.isJSXExpressionContainer(attribute.value)) {
    return t.isJSXEmptyExpression(attribute.value.expression) ? null : attribute.value.expression;
  }
  return null;
}

/**
 * v6 nests by JSX containment; v5 absolute paths are unaffected. Runs to the top
 * of the file — the parent chain counts wrappers, so a hop limit would drop the
 * prefix in deeply indented JSX.
 */
function jsxPrefix(nodePath: NodePath<t.JSXOpeningElement>, constants: Constants): string {
  const parts: string[] = [];
  let current: NodePath = nodePath;

  while (parts.length < NESTING_CAP) {
    const parent: NodePath | null = current.parentPath;
    if (!parent) break;
    // The element that owns this opening tag is not an ancestor route.
    if (
      parent.isJSXElement() &&
      parent.node.openingElement !== nodePath.node &&
      isRouteElement(parent.node.openingElement)
    ) {
      const attribute = pathAttribute(parent.node.openingElement);
      const raw = attribute ? constants.string(valueOfAttribute(attribute)) : null;
      if (raw) parts.unshift(raw);
    }
    current = parent;
  }

  return parts.reduce<string>((prefix, part) => joinConfigPath(prefix, part), '');
}

function componentFileOfElement(node: t.JSXOpeningElement, constants: Constants): string | null {
  for (const name of ['component', 'Component', 'element', 'render']) {
    const attribute = node.attributes.find(
      (candidate): candidate is t.JSXAttribute =>
        t.isJSXAttribute(candidate) && jsxAttributeName(candidate) === name,
    );
    if (!attribute) continue;
    const value = valueOfAttribute(attribute);
    if (!value) continue;
    if (t.isIdentifier(value)) {
      const file = constants.fileOf(value.name);
      if (file) return file;
    }
    if (t.isJSXElement(value)) {
      const inner = jsxName(value.openingElement.name);
      const file = constants.fileOf(inner.split('.')[0]!);
      if (file) return file;
    }
  }
  return null;
}

function jsxName(node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(node)) return node.name;
  if (t.isJSXNamespacedName(node)) return `${node.namespace.name}:${node.name.name}`;
  return `${jsxName(node.object)}.${node.property.name}`;
}

function jsxAttributeName(attribute: t.JSXAttribute): string {
  return t.isJSXIdentifier(attribute.name)
    ? attribute.name.name
    : `${attribute.name.namespace.name}:${attribute.name.name.name}`;
}

/** One route declared twice — a nested `<Route>` repeated per layout — is one screen. */
function dedupe(drafts: readonly ScreenDraft[]): ScreenDraft[] {
  const byRoute = new Map<string, ScreenDraft>();
  for (const draft of drafts) {
    const existing = byRoute.get(draft.route);
    if (!existing) {
      byRoute.set(draft.route, draft);
      continue;
    }
    // Prefer the declaration that resolved to a component file.
    if (!existing.absolute && draft.absolute) byRoute.set(draft.route, draft);
  }
  return [...byRoute.values()];
}
