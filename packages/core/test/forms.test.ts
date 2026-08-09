import { describe, expect, it } from 'vitest';
import { FIXED_DATE, planForm, synthesizeValue, type FormControl, type FormGroup } from '@jsxray/core';

const control = (partial: Partial<FormControl> & { type: string }): FormControl => ({
  ref: `#${partial.name ?? partial.type}`,
  name: null,
  label: null,
  autocomplete: null,
  required: false,
  options: null,
  min: null,
  ...partial,
});

const form = (controls: FormControl[]): FormGroup => ({
  ref: 'form',
  label: 'Sign up',
  controls,
  submit: { ref: '#submit', label: 'Continue', target: null, role: 'button', inOverlay: false },
});

describe('synthesizeValue', () => {
  it('follows the strongest available signal', () => {
    expect(synthesizeValue(control({ type: 'email' }))).toBe('jsxray@example.com');
    expect(synthesizeValue(control({ type: 'text', autocomplete: 'email' }))).toBe('jsxray@example.com');
    expect(synthesizeValue(control({ type: 'tel' }))).toBe('5550100000');
    expect(synthesizeValue(control({ type: 'url' }))).toBe('https://example.com');
    expect(synthesizeValue(control({ type: 'number', min: '7' }))).toBe('7');
    expect(synthesizeValue(control({ type: 'number' }))).toBe('1');
    expect(synthesizeValue(control({ type: 'text', name: 'fullName' }))).toBe('Test');
    expect(synthesizeValue(control({ type: 'text' }))).toBe('jsxray');
  });

  it('uses a fixed date, because a synthesized today would break determinism', () => {
    expect(synthesizeValue(control({ type: 'date' }))).toBe(FIXED_DATE);
  });

  it('picks the first non-empty option of a select', () => {
    expect(synthesizeValue(control({ type: 'select', options: ['', 'free', 'pro'] }))).toBe('free');
  });

  it('never synthesizes a password', () => {
    expect(synthesizeValue(control({ type: 'password' }))).toBeNull();
  });

  it('leaves checkboxes at their default unless required', () => {
    expect(synthesizeValue(control({ type: 'checkbox' }))).toBeNull();
    expect(synthesizeValue(control({ type: 'checkbox', required: true }))).toBe('on');
  });
});

describe('planForm', () => {
  it('fills every synthesizable field, then activates submit', () => {
    const plan = planForm(form([control({ type: 'email', name: 'email' }), control({ type: 'text', name: 'name' })]));
    expect(plan.skipped).toBeNull();
    expect(plan.fills.map((fill) => fill.value)).toEqual(['jsxray@example.com', 'Test']);
    expect(plan.submit?.label).toBe('Continue');
  });

  it('refuses the whole form when any field is a payment field', () => {
    const plan = planForm(form([control({ type: 'text', name: 'cardNumber', label: 'Card number' })]));
    expect(plan.skipped?.code).toBe('payment-field');
    expect(plan.fills).toHaveLength(0);
  });

  it('skips rather than submitting a half-filled form', () => {
    const plan = planForm(form([control({ type: 'password', name: 'password', required: true })]));
    expect(plan.skipped?.code).toBe('unsynthesizable-required');
  });

  it('lets a config override win over any signal', () => {
    const plan = planForm(form([control({ type: 'email', name: 'email' })]), {
      email: 'someone@real.test',
    });
    expect(plan.fills[0]?.value).toBe('someone@real.test');
  });
});
