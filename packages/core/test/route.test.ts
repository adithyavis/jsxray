import { describe, expect, it } from 'vitest';
import {
  canonicalizePattern,
  canonicalizeUrl,
  edgeMatchKey,
  inferRoutePatterns,
  looksLikeId,
  matchRoute,
  overlaysOfStateSignature,
  screenId,
  screenOfStateSignature,
  stateSignature,
  stripUrl,
} from '@jsxray/core';

describe('canonicalizePattern', () => {
  it('maps every Next dynamic shape', () => {
    expect(canonicalizePattern('/posts/[id]')).toBe('/posts/:id');
    expect(canonicalizePattern('/docs/[...slug]')).toBe('/docs/*slug');
    expect(canonicalizePattern('/docs/[[...slug]]')).toBe('/docs/*slug?');
  });

  it('passes react-router syntax through', () => {
    expect(canonicalizePattern('/posts/:id')).toBe('/posts/:id');
    expect(canonicalizePattern('/')).toBe('/');
  });
});

describe('matchRoute', () => {
  const patterns = ['/tx/:id', '/tx/new', '/docs/*slug', '/'];

  it('prefers literal segments over dynamic ones', () => {
    expect(matchRoute('/tx/new', patterns)?.route).toBe('/tx/new');
    expect(matchRoute('/tx/9182', patterns)?.route).toBe('/tx/:id');
  });

  it('captures params and catch-alls', () => {
    expect(matchRoute('/tx/9182', patterns)?.params).toEqual({ id: '9182' });
    expect(matchRoute('/docs/a/b/c', patterns)?.params).toEqual({ slug: 'a/b/c' });
  });

  it('returns null when nothing matches', () => {
    expect(matchRoute('/nope/deep', patterns)).toBeNull();
  });
});

describe('canonicalizeUrl', () => {
  it('uses declared patterns for real param names', () => {
    expect(canonicalizeUrl('http://localhost:3000/tx/9182?q=1#x', ['/tx/:id'])).toBe('/tx/:id');
  });

  it('falls back to the id-shape heuristic', () => {
    expect(canonicalizeUrl('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe('/orders/:id');
    expect(canonicalizeUrl('/orders/12')).toBe('/orders/:id');
    expect(canonicalizeUrl('/orders/summary')).toBe('/orders/summary');
  });

  it('strips origin, query, hash, and trailing slashes', () => {
    expect(stripUrl('https://app.test/a/b/?x=1#y')).toBe('/a/b');
    expect(stripUrl('https://app.test/')).toBe('/');
  });
});

describe('looksLikeId', () => {
  it('treats slugs as names, not ids', () => {
    expect(looksLikeId('getting-started')).toBe(false);
    expect(looksLikeId('42')).toBe(true);
    expect(looksLikeId('507f1f77bcf86cd799439011')).toBe(true);
  });
});

describe('identity separators', () => {
  it('keeps a not-found screen apart from a Not Found overlay over /', () => {
    const notFoundScreen = screenId('/', 'not-found');
    const overlayOverRoot = stateSignature('/', ['Not found']);
    expect(notFoundScreen).toBe('/#not-found');
    expect(overlayOverRoot).toBe('/$not-found');
    expect(notFoundScreen).not.toBe(overlayOverRoot);
  });

  it('stacks overlays outermost first', () => {
    const signature = stateSignature('/settings', ['Manage billing', 'Confirm deletion']);
    expect(signature).toBe('/settings$manage-billing$confirm-deletion');
    expect(screenOfStateSignature(signature)).toBe('/settings');
    expect(overlaysOfStateSignature(signature)).toEqual(['manage-billing', 'confirm-deletion']);
  });
});

describe('edgeMatchKey', () => {
  it('drops overlay segments so an overlay confirms its screen candidate', () => {
    expect(edgeMatchKey('/posts$share', '/inbox')).toBe('/posts /inbox');
    expect(edgeMatchKey('/posts', null)).toBeNull();
  });
});

describe('inferRoutePatterns', () => {
  it('learns a param once enough values share a position', () => {
    expect(
      inferRoutePatterns(['/profile/bsky.app', '/profile/bossett.social', '/profile/propublica.org']),
    ).toEqual(['/profile/:profile']);
  });

  it('learns several positions in the same shape', () => {
    expect(
      inferRoutePatterns([
        '/profile/a/feed/whats-hot',
        '/profile/b/feed/for-science',
        '/profile/c/feed/art-new',
      ]),
    ).toEqual(['/profile/:profile/feed/:feed']);
  });

  it('leaves two sibling screens alone', () => {
    expect(inferRoutePatterns(['/settings/privacy', '/settings/saved-feeds'])).toEqual([]);
  });

  it('never generalizes the first segment, however many there are', () => {
    expect(inferRoutePatterns(['/feeds', '/settings', '/notifications', '/messages'])).toEqual([]);
  });

  it('keeps shapes apart even when they are the same length', () => {
    const learned = inferRoutePatterns([
      '/profile/a',
      '/profile/b',
      '/profile/c',
      '/settings/privacy',
    ]);
    expect(learned).toEqual(['/profile/:profile']);
  });
});
