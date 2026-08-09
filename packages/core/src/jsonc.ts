/**
 * §12 — a real scanner, not regexes. tsconfig data is full of comment-like text:
 * `"@/*"` opens what looks like a block comment and `"**\/*.ts"` closes it.
 */
export function parseJsonc<T = unknown>(source: string): T {
  return JSON.parse(stripJsonc(source)) as T;
}

export function stripJsonc(source: string): string {
  let out = '';
  let index = 0;
  let inString = false;

  while (index < source.length) {
    const char = source[index]!;

    if (inString) {
      out += char;
      if (char === '\\') {
        out += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index++;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index++;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index += 2;
      continue;
    }

    out += char;
    index++;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}
