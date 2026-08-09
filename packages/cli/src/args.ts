export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
}

const ALIASES: Record<string, string> = {
  c: 'config',
  u: 'url',
  o: 'out',
  s: 'stages',
  f: 'file',
  p: 'port',
  l: 'list',
  e: 'export',
  q: 'quiet',
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;

    if (token.startsWith('--')) {
      const [rawName, inlineValue] = splitOnce(token.slice(2), '=');
      const negated = rawName.startsWith('no-');
      const name = negated ? rawName.slice(3) : rawName;
      if (negated) {
        flags[name] = false;
        continue;
      }
      const next = argv[index + 1];
      if (inlineValue !== null) flags[name] = inlineValue;
      else if (next && !next.startsWith('-')) flags[name] = argv[++index]!;
      else flags[name] = true;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const name = ALIASES[token.slice(1)] ?? token.slice(1);
      const next = argv[index + 1];
      if (next && !next.startsWith('-')) flags[name] = argv[++index]!;
      else flags[name] = true;
      continue;
    }

    if (command === null) command = token;
    else positional.push(token);
  }

  return { command, flags, positional };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | null {
  const value = flags[name];
  return typeof value === 'string' ? value : null;
}

export function flagBoolean(flags: ParsedArgs['flags'], name: string, fallback = false): boolean {
  const value = flags[name];
  return typeof value === 'boolean' ? value : value === undefined ? fallback : true;
}

export function flagNumber(flags: ParsedArgs['flags'], name: string): number | null {
  const value = flagString(flags, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function flagList(flags: ParsedArgs['flags'], name: string): string[] | null {
  const value = flagString(flags, name);
  if (value === null) return null;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, null];
  return [value.slice(0, index), value.slice(index + 1)];
}
