import { describe, expect, it } from 'vitest';
import { createGuard, type Clickable, type FormGroup } from '@jsxray/core';

const link = (label: string, target: string | null): Clickable => ({
  ref: `#${label}`,
  label,
  target,
  role: 'link',
  inOverlay: false,
});

describe('safety guard', () => {
  it('blocks the built-in denylist by target', () => {
    const guard = createGuard();
    expect(guard.blocksNavigation('/account/logout')).toBe(true);
    expect(guard.blocksNavigation('https://app.test/billing/cancel')).toBe(true);
    expect(guard.blocksNavigation('/dashboard')).toBe(false);
  });

  it('blocks by visible label when there is no target at all', () => {
    const guard = createGuard();
    expect(guard.filterActions([link('Delete workspace', null)])).toHaveLength(0);
    expect(guard.filterActions([link('Open settings', null)])).toHaveLength(1);
  });

  it('lets user rules extend the built-ins, never replace them', () => {
    const guard = createGuard({ navigation: ['**/beta'] });
    expect(guard.blocksNavigation('/features/beta')).toBe(true);
    expect(guard.blocksNavigation('/logout')).toBe(true);
  });

  it('keeps the three rules orthogonal', () => {
    const guard = createGuard({
      navigation: ['/never'],
      actions: ['/frozen'],
      screenshots: ['/settings/secrets'],
    });
    expect(guard.blocksScreenshot('/settings/secrets')).toBe(true);
    expect(guard.blocksScreenshot('/settings')).toBe(false);
    expect(guard.blocksActions('/frozen')).toBe(true);
    expect(guard.blocksActions('/settings/secrets')).toBe(false);
  });

  it('matches a bare path exactly, not its descendants', () => {
    const guard = createGuard({ screenshots: ['/settings/secrets'] });
    expect(guard.blocksScreenshot('/settings/secrets')).toBe(true);
    expect(guard.blocksScreenshot('/settings/secrets/keys')).toBe(false);
    expect(createGuard({ screenshots: ['/settings/secrets/**'] }).blocksScreenshot(
      '/settings/secrets/keys',
    )).toBe(true);
  });

  it('ignores overlay segments when matching a state route', () => {
    const guard = createGuard({ screenshots: ['/settings'] });
    expect(guard.blocksScreenshot('/settings$confirm-deletion')).toBe(true);
  });

  it('rejects a form whose submit control is destructive', () => {
    const form: FormGroup = {
      ref: 'form',
      label: 'Danger zone',
      controls: [],
      submit: link('Delete account', null),
    };
    expect(createGuard().filterActions([form])).toHaveLength(0);
  });
});
