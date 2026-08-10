import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
  routeParams,
  type Diagnostic,
  type EnumerateInput,
  type EnumerateOutput,
  type NavIntent,
  type NavRecognizers,
  type RouterProvider,
} from '@jsxray/core';
import { buildCandidateEdges, buildScreens, type ScreenDraft } from '../shared.js';
import {
  Constants,
  createScanContext,
  joinConfigPath,
  normalizeConfigPath,
  propertyKey,
  scanSources,
  traverse,
  type SourceFile,
} from '../config-scan.js';

/**
 * §4.1 — `navigate` is matched bare because `useNavigation()` destructures it;
 * `push` needs a receiver, being an array method far more often than a screen.
 */
export const reactNavigationRecognizers: NavRecognizers = {
  linkProps: [
    { element: 'Link', prop: 'to' },
    { element: 'Link', prop: 'href' },
  ],
  calls: [
    { callee: 'navigate', kind: 'push', target: { arg: 0 } },
    { callee: 'navigation.navigate', kind: 'push', target: { arg: 0 } },
    { callee: 'navigation.push', kind: 'push', target: { arg: 0 } },
    { callee: 'navigation.replace', kind: 'replace', target: { arg: 0 } },
    { callee: 'navigation.goBack', kind: 'back', target: { arg: 0 } },
  ],
};

const LINKING_KEYS = /\bscreens\s*:/;
const PATH_MAP_NAME = /^(routes?|router|ROUTES|linking|LINKING|screens)$/;
const ROUTER_CONSTRUCTOR = /Router$/;

/** A path map needs this many path-like values before it is one. */
const PATH_MAP_MINIMUM = 3;

/**
 * §13.2 — enumerates the linkable surface, since a path exists only where the app
 * declared one, and resolves named `navigate()` targets through the same table.
 */
export const reactNavigationRouter: RouterProvider = {
  axis: 'router',
  id: 'react-navigation',
  priority: 14,
  capabilities: { discovery: ['config'] },
  recognizers: reactNavigationRecognizers,

  supports: (profile) => profile.router === 'react-navigation',

  async enumerate(input: EnumerateInput): Promise<EnumerateOutput> {
    const diagnostics: Diagnostic[] = [];
    const context = createScanContext(input.root, input.profile);
    const files = scanSources(input.root, input.profile, isCandidate);

    /** Screen name → every path declared for it. */
    const byName = new Map<string, string[]>();
    const componentByName = new Map<string, ScreenComponent>();

    for (const file of files) {
      const constants = new Constants(context, file.absolute, file.ast);
      for (const [name, paths] of readPaths(file, constants)) {
        byName.set(name, [...(byName.get(name) ?? []), ...paths]);
      }
      for (const [name, component] of readScreenComponents(file, constants)) {
        if (!componentByName.has(name)) componentByName.set(name, component);
      }
    }

    if (!byName.size) {
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
              'react-navigation detected but no linking config or path map was found; screens are named-only and have no URLs to enumerate (§4.3)',
          },
        ],
      };
    }

    const drafts: ScreenDraft[] = [];
    /** The canonical route each screen name resolves to, for intent rewriting. */
    const routeByName = new Map<string, string>();

    for (const [name, paths] of byName) {
      for (const raw of paths) {
        const route = normalizeConfigPath(raw);
        if (!route) continue;
        if (!routeByName.has(name)) routeByName.set(name, route);
        const component = componentByName.get(name);
        drafts.push({
          route,
          pattern: raw,
          kind: 'page',
          isPage: true,
          absolute: component?.absolute ?? null,
          componentName: component?.exported ?? null,
          meta: { groups: [], dynamic: routeParams(route).length > 0, params: routeParams(route) },
        });
      }
    }

    const screens = buildScreens(input.root, dedupe(drafts), input.fileExports);
    const { intents, resolved } = resolveNamedTargets(input.navIntents, routeByName);
    const { edges, unattributed } = buildCandidateEdges(input.root, screens, intents);

    if (resolved) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'named-targets-resolved',
        message: `${resolved} navigate() calls target a screen name; resolved through the linking config`,
      });
    }
    if (unattributed) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'unattributed-intents',
        message: `${unattributed} nav intents live in shared components and belong to no single screen`,
      });
    }

    const named = [...byName.keys()].filter((name) => !routeByName.has(name));
    if (named.length) {
      diagnostics.push({
        level: 'info',
        stage: 'enumerate',
        code: 'unlinkable-screens',
        message: `${named.length} screens are registered but declare no path, so they have no URL to visit`,
      });
    }

    return { screens, edges, strategy: 'config', diagnostics };
  },
};

function isCandidate(source: string): boolean {
  if (LINKING_KEYS.test(source)) return true;
  if (/NavigationContainer|createNativeStackNavigator|createBottomTabNavigator/.test(source)) {
    return true;
  }
  return /\bnew\s+\w*Router\s*[<(]/.test(source);
}

/* ── path discovery ───────────────────────────────────────────────────────── */

/** §13.2 — a nested `linking.config.screens` tree, or a flat screen→path map. */
function readPaths(file: SourceFile, constants: Constants): Map<string, string[]> {
  const found = new Map<string, string[]>();

  const add = (name: string, path: string): void => {
    found.set(name, [...(found.get(name) ?? []), path]);
  };

  traverse(file.ast, {
    ObjectProperty(nodePath) {
      if (propertyKey(nodePath.node) !== 'screens') return;
      if (!t.isObjectExpression(nodePath.node.value)) return;
      // §13.2 — outermost only; a nested tree is already walked with its prefix.
      if (isNestedScreens(nodePath)) return;
      readScreenTree(nodePath.node.value, '', constants, add);
    },

    ObjectExpression(nodePath) {
      if (!isPathMap(nodePath.node, constants)) return;
      if (!isPathMapContext(nodePath)) return;
      for (const property of nodePath.node.properties) {
        if (!t.isObjectProperty(property)) continue;
        const name = propertyKey(property);
        if (!name) continue;
        for (const path of pathValues(property.value, constants)) add(name, path);
      }
    },
  });

  return found;
}

function isNestedScreens(nodePath: NodePath<t.ObjectProperty>): boolean {
  let current: NodePath | null = nodePath.parentPath;
  while (current) {
    if (current.isObjectProperty() && propertyKey(current.node) === 'screens') return true;
    current = current.parentPath;
  }
  return false;
}

/** `screens: { Home: '', Profile: { path: 'user/:id', screens: {…} } }`. */
function readScreenTree(
  node: t.ObjectExpression,
  prefix: string,
  constants: Constants,
  add: (name: string, path: string) => void,
): void {
  for (const property of node.properties) {
    if (!t.isObjectProperty(property)) continue;
    const name = propertyKey(property);
    if (!name) continue;

    const value = property.value;

    if (t.isStringLiteral(value) || t.isTemplateLiteral(value)) {
      const raw = constants.string(value);
      if (raw !== null) add(name, joinConfigPath(prefix, raw));
      continue;
    }

    if (!t.isObjectExpression(value)) continue;

    const pathProperty = value.properties.find(
      (candidate): candidate is t.ObjectProperty =>
        t.isObjectProperty(candidate) && propertyKey(candidate) === 'path',
    );
    const raw = pathProperty ? constants.string(pathProperty.value) : null;
    const nested = raw !== null ? joinConfigPath(prefix, raw) : prefix;
    if (raw !== null) add(name, nested);

    const screens = value.properties.find(
      (candidate): candidate is t.ObjectProperty =>
        t.isObjectProperty(candidate) && propertyKey(candidate) === 'screens',
    );
    if (screens && t.isObjectExpression(screens.value)) {
      readScreenTree(screens.value, nested, constants, add);
    }
  }
}

/** `{ Home: ['/', '/download'], Profile: '/profile/:name' }`. */
function isPathMap(node: t.ObjectExpression, constants: Constants): boolean {
  let pathLike = 0;
  for (const property of node.properties) {
    if (!t.isObjectProperty(property)) continue;
    if (!propertyKey(property)) continue;
    const values = pathValues(property.value, constants);
    if (!values.length) return false;
    if (values.every((value) => value.startsWith('/'))) pathLike++;
    else return false;
  }
  return pathLike >= PATH_MAP_MINIMUM;
}

/** §13.2 — path-shaped strings are a route table only where used as one. */
function isPathMapContext(nodePath: NodePath<t.ObjectExpression>): boolean {
  const parent = nodePath.parentPath;
  if (!parent) return false;

  if (parent.isNewExpression() || parent.isCallExpression()) {
    const { callee } = parent.node;
    const name = t.isIdentifier(callee)
      ? callee.name
      : t.isMemberExpression(callee) && t.isIdentifier(callee.property)
        ? callee.property.name
        : null;
    return !!name && ROUTER_CONSTRUCTOR.test(name);
  }

  if (parent.isVariableDeclarator()) {
    return t.isIdentifier(parent.node.id) && PATH_MAP_NAME.test(parent.node.id.name);
  }

  return false;
}

function pathValues(node: t.Node, constants: Constants): string[] {
  if (t.isArrayExpression(node)) {
    const values: string[] = [];
    for (const element of node.elements) {
      if (!element || !t.isExpression(element)) return [];
      const value = constants.string(element);
      if (value === null) return [];
      values.push(value);
    }
    return values;
  }
  const value = constants.string(node);
  return value === null ? [] : [value];
}

/* ── screen components ────────────────────────────────────────────────────── */

export interface ScreenComponent {
  absolute: string;
  /** The export name in that file, which is rarely `default` in React Native. */
  exported: string | null;
}

/** `<Stack.Screen name="Profile" component={ProfileScreen} />`. */
function readScreenComponents(
  file: SourceFile,
  constants: Constants,
): Map<string, ScreenComponent> {
  const found = new Map<string, ScreenComponent>();

  traverse(file.ast, {
    JSXOpeningElement(nodePath) {
      const element = jsxName(nodePath.node.name);
      if (element !== 'Screen' && !element.endsWith('.Screen')) return;

      const name = attributeString(nodePath.node, 'name', constants);
      if (!name) return;

      for (const attribute of ['component', 'getComponent', 'children']) {
        const value = attributeValue(nodePath.node, attribute);
        if (!value) continue;
        const identifier = componentIdentifier(value);
        if (!identifier) continue;
        const absolute = constants.fileOf(identifier);
        if (absolute) {
          found.set(name, { absolute, exported: constants.exportedNameOf(identifier) });
          break;
        }
      }
    },
  });

  return found;
}

function componentIdentifier(node: t.Node): string | null {
  if (t.isIdentifier(node)) return node.name;
  if (t.isArrowFunctionExpression(node) && t.isExpression(node.body)) {
    return componentIdentifier(node.body);
  }
  if (t.isJSXElement(node)) return jsxName(node.openingElement.name).split('.')[0]!;
  return null;
}

function attributeString(
  node: t.JSXOpeningElement,
  name: string,
  constants: Constants,
): string | null {
  const value = attributeValue(node, name);
  return value ? constants.string(value) : null;
}

function attributeValue(node: t.JSXOpeningElement, name: string): t.Node | null {
  const attribute = node.attributes.find(
    (candidate): candidate is t.JSXAttribute =>
      t.isJSXAttribute(candidate) &&
      t.isJSXIdentifier(candidate.name) &&
      candidate.name.name === name,
  );
  if (!attribute?.value) return null;
  if (t.isStringLiteral(attribute.value)) return attribute.value;
  if (t.isJSXExpressionContainer(attribute.value)) {
    return t.isJSXEmptyExpression(attribute.value.expression) ? null : attribute.value.expression;
  }
  return null;
}

/* ── named targets ────────────────────────────────────────────────────────── */

/** §13.2 — rewrites a screen-name target to its route so edges can resolve. */
function resolveNamedTargets(
  intents: readonly NavIntent[],
  routeByName: ReadonlyMap<string, string>,
): { intents: NavIntent[]; resolved: number } {
  let resolved = 0;
  const rewritten = intents.map((intent) => {
    if (!intent.target || intent.target.startsWith('/')) return intent;
    const route = routeByName.get(intent.target);
    if (!route) return intent;
    resolved++;
    return { ...intent, target: route };
  });
  return { intents: rewritten, resolved };
}

function jsxName(node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(node)) return node.name;
  if (t.isJSXNamespacedName(node)) return `${node.namespace.name}:${node.name.name}`;
  return `${jsxName(node.object)}.${node.property.name}`;
}

function dedupe(drafts: readonly ScreenDraft[]): ScreenDraft[] {
  const byRoute = new Map<string, ScreenDraft>();
  for (const draft of drafts) {
    const existing = byRoute.get(draft.route);
    if (!existing) {
      byRoute.set(draft.route, draft);
      continue;
    }
    if (!existing.absolute && draft.absolute) byRoute.set(draft.route, draft);
  }
  return [...byRoute.values()];
}
