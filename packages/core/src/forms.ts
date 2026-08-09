import type { Clickable, FormControl, FormGroup } from './runtime.js';

/** §7.3 — a hard built-in, not a default the user can relax. */
const PAYMENT_WORDS = new Set([
  'card',
  'cardnumber',
  'cc',
  'ccnum',
  'cvv',
  'cvc',
  'expiry',
  'expdate',
  'iban',
  'routing',
  'sortcode',
]);

/** `cardNumber` and `card_number` are the same field as `card number`. */
function words(identity: string): string[] {
  return identity
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isPaymentField(identity: string): boolean {
  const parts = words(identity);
  return parts.some(
    (word, index) =>
      PAYMENT_WORDS.has(word) ||
      (index > 0 && PAYMENT_WORDS.has(`${parts[index - 1]}${word}`)),
  );
}

export const FIXED_DATE = '2020-01-01';
export const FIXED_TIME = '12:00';

export interface FormFill {
  ref: string;
  value: string;
  label: string | null;
}

export interface FormPlan {
  fills: FormFill[];
  submit: Clickable | null;
  /** Set when the whole form is skipped; nothing is filled. */
  skipped: { code: 'payment-field' | 'unsynthesizable-required'; message: string } | null;
}

export function planForm(form: FormGroup, overrides: Record<string, string> = {}): FormPlan {
  const fills: FormFill[] = [];

  for (const control of form.controls) {
    const identity = `${control.name ?? ''} ${control.label ?? ''}`;

    if (isPaymentField(identity)) {
      return {
        fills: [],
        submit: form.submit,
        skipped: {
          code: 'payment-field',
          message: `payment field ${JSON.stringify(control.name ?? control.label ?? control.type)}`,
        },
      };
    }

    const override = control.name ? overrides[control.name] : undefined;
    const value = override ?? synthesizeValue(control);

    if (value === null) {
      if (control.required) {
        return {
          fills: [],
          submit: form.submit,
          skipped: {
            code: 'unsynthesizable-required',
            message: `required ${control.type} field ${JSON.stringify(
              control.name ?? control.label ?? '',
            )} has no synthesizable value`,
          },
        };
      }
      continue;
    }

    fills.push({ ref: control.ref, value, label: control.label });
  }

  return { fills, submit: form.submit, skipped: null };
}

export function synthesizeValue(control: FormControl): string | null {
  const identity = `${control.name ?? ''} ${control.label ?? ''}`;
  const autocomplete = control.autocomplete ?? '';

  if (control.type === 'password') return null;

  if (control.type === 'select') {
    return control.options?.find((option) => option.length > 0) ?? null;
  }

  if (control.type === 'checkbox' || control.type === 'radio') {
    return control.required ? 'on' : null;
  }

  if (control.type === 'email' || autocomplete === 'email') return 'jsxray@example.com';
  if (control.type === 'tel' || autocomplete === 'tel') return '5550100000';
  if (control.type === 'url') return 'https://example.com';
  if (control.type === 'number' || control.type === 'range') return control.min ?? '1';
  if (control.type === 'date') return FIXED_DATE;
  if (control.type === 'time') return FIXED_TIME;
  if (control.type === 'datetime-local') return `${FIXED_DATE}T${FIXED_TIME}`;
  if (control.type === 'month') return FIXED_DATE.slice(0, 7);
  if (control.type === 'color') return '#3355ff';

  if (words(identity).includes('name')) return 'Test';
  return 'jsxray';
}
