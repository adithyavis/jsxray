export type ElementRef = string;

export interface Clickable {
  ref: ElementRef;
  label: string | null;
  target: string | null;
  role: string | null;
  inOverlay: boolean;
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

export interface Observation {
  url: string;
  overlays: Overlay[];
  fingerprint: string;
}
