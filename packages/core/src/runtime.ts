export type ElementRef = string;

export interface Clickable {
  ref: ElementRef;
  label: string | null;
  /** In-app path only. An off-site link has `null` here and `external` set. */
  target: string | null;
  role: string | null;
  inOverlay: boolean;
  /** §7.12 — it leaves the app, so it is not a route. Absent when unknowable. */
  external?: boolean;
}

export interface FormControl {
  ref: ElementRef;
  type: string;
  name: string | null;
  label: string | null;
  autocomplete: string | null;
  required: boolean;
  options: string[] | null;
  min: string | null;
}

export interface FormGroup {
  ref: ElementRef;
  label: string | null;
  controls: FormControl[];
  submit: Clickable | null;
}

export interface Overlay {
  name: string | null;
  role: string;
  via: 'role' | 'dialog-element' | 'inert-background';
  /** Fallback identity for an unnamed overlay — never the page's (§3.1). */
  subtreeHash: string;
}

export type SessionState = unknown;

/**
 * §7.10 — what the viewport is showing right now. `loading` is a skeleton or a
 * spinner: the page has stopped moving but the data behind it has not arrived.
 */
export type RenderStatus = 'ok' | 'loading' | 'blank';

/**
 * §7.11 — the renderer tags a press the page never received, so an interception
 * cannot hide inside the general `action-failed` bucket.
 */
export const INTERCEPTED_TAG = 'jsxray:intercepted';

/**
 * §7.11 — and the sibling case: the ref matched nothing at all. A control the app
 * re-rendered out from under the crawl is not a control that did nothing.
 */
export const STALE_REF_TAG = 'jsxray:stale-ref';

export function isIntercepted(error: unknown): boolean {
  return messageOf(error).includes(INTERCEPTED_TAG);
}

export function isStaleRef(error: unknown): boolean {
  return messageOf(error).includes(STALE_REF_TAG);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Observation {
  url: string;
  overlays: Overlay[];
  fingerprint: string;
}
