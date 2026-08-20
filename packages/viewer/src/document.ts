import type { Edge, JsxrayDocument, OverlayRef, Screen, ScreenState } from '@jsxray/core';

declare global {
  interface Window {
    __JSXRAY__?: JsxrayDocument;
  }
}

export async function loadDocument(): Promise<JsxrayDocument> {
  if (window.__JSXRAY__) return window.__JSXRAY__;
  const response = await fetch('./jsxray.json');
  if (!response.ok) throw new Error(`could not read jsxray.json (${response.status})`);
  return (await response.json()) as JsxrayDocument;
}

export function hasRun(document: JsxrayDocument, stage: string): boolean {
  return document.stages.some((entry) => entry.name === stage && entry.status === 'ok');
}

export function screenOf(document: JsxrayDocument, state: ScreenState): Screen | null {
  return document.screens.find((screen) => screen.id === state.screenId) ?? null;
}

/**
 * §14 — the part of the app a screen belongs to: its first route group, falling
 * back to the parent path segment. The node eyebrow and the flow list are the
 * same answer in two type cases, so they are the same function.
 */
export function sectionOf(screen: Screen | null, route: string): string | null {
  const group = screen?.meta.groups[0];
  if (group) return deSlug(group);
  const segments = route.split('$')[0]!.split('/').filter(Boolean);
  // A section is a part of the app, and a parameter is not one: the screens under
  // `/profile/:name/post/:rkey` belong to `post`, never to `:name`.
  for (let at = segments.length - 2; at >= 0; at -= 1) {
    const segment = segments[at]!;
    if (segment.startsWith(':') || segment.startsWith('*')) continue;
    return deSlug(segment);
  }
  return null;
}

/** §14 — eyebrow, title, caption are presentation, computed here and nowhere else. */
export function eyebrowOf(screen: Screen | null, route: string): string | null {
  return sectionOf(screen, route)?.toUpperCase() ?? null;
}

/** An unnamed overlay falls back to a hash (§3.1), which is not a title. */
const HASH_NAME = /^[0-9a-f]{6,}$/i;

export function titleOf(signature: string): string {
  const screenId = signature.split('$')[0]!;
  const overlays = signature.split('$').slice(1);
  if (overlays.length) {
    const name = overlays[overlays.length - 1]!;
    return HASH_NAME.test(name) ? `${titleOf(screenId)} · Dialog` : deSlug(name);
  }

  const [route, suffix] = screenId.split('#');
  const segments = route!.split('/').filter(Boolean);
  if (!segments.length) return suffix ? deSlug(suffix) : 'Home';

  const last = segments[segments.length - 1]!;
  if (last.startsWith('*')) return deSlug(last.slice(1).replace(/\?$/, ''));
  if (last.startsWith(':')) {
    const parent = segments[segments.length - 2];
    return parent ? `${deSlug(parent)} Detail` : `${deSlug(last.slice(1))} Detail`;
  }
  return deSlug(last);
}

/** How long a fallback label may be before it stops being a label (§14). */
const LABEL_LIMIT = 40;

/**
 * §14 — the drawn edge names the **transition**, not the words on the control.
 * "View this user's verifications" is a sentence; `/profile/:name/verified` is
 * where it goes. The control's own words stay in the document and the inspector.
 */
export function transitionOf(from: ScreenState, to: ScreenState, edge: Edge): string {
  if (from.screenId !== to.screenId) return `Navigate to ${to.route}`;

  const opened = to.overlays.filter((overlay) => !holds(from.overlays, overlay));
  if (opened.length) return `Open the ${overlayWords(opened[opened.length - 1]!)}`;

  const closed = from.overlays.filter((overlay) => !holds(to.overlays, overlay));
  if (closed.length) return `Close the ${overlayWords(closed[closed.length - 1]!)}`;

  const label = edge.label ? shorten(edge.label) : null;
  if (edge.kind === 'form') return label ? `Submit ${label}` : 'Submit the form';
  return label ?? edge.kind;
}

function holds(overlays: readonly OverlayRef[], overlay: OverlayRef): boolean {
  return overlays.some((candidate) => candidate.name === overlay.name);
}

/** An unnamed overlay is known only by its role, which is still what it is. */
function overlayWords(overlay: OverlayRef): string {
  const noun = overlay.role === 'alertdialog' ? 'dialog' : overlay.role || 'overlay';
  if (HASH_NAME.test(overlay.name)) return noun;
  const words = overlay.name.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words.endsWith(noun) ? words : `${words} ${noun}`;
}

function shorten(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1).trimEnd()}…` : text;
}

export function deSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}
