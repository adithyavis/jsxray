import type { JsxrayDocument, Screen, ScreenState } from '@jsxray/core';

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

/** §14 — eyebrow, title, caption are presentation, computed here and nowhere else. */
export function eyebrowOf(screen: Screen | null, route: string): string | null {
  const group = screen?.meta.groups[0];
  if (group) return group.toUpperCase();
  const segments = route.split('$')[0]!.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return deSlug(segments[segments.length - 2]!).toUpperCase();
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

export function deSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}
