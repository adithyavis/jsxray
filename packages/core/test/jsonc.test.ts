import { describe, expect, it } from 'vitest';
import { parseJsonc } from '@jsxray/core';

describe('parseJsonc', () => {
  it('survives the comment-like text a real tsconfig is full of', () => {
    const source = `{
      // paths for the app
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["./*"] }   /* alias */
      },
      "include": ["**/*.ts", "**/*.tsx"],
    }`;
    const parsed = parseJsonc<{ compilerOptions: { paths: Record<string, string[]> } }>(source);
    expect(parsed.compilerOptions.paths['@/*']).toEqual(['./*']);
  });

  it('does not treat a string as a comment opener', () => {
    expect(parseJsonc<{ a: string }>('{ "a": "http://x/y" }').a).toBe('http://x/y');
    expect(parseJsonc<{ a: string }>('{ "a": "a\\"// not a comment" }').a).toBe('a"// not a comment');
  });
});
