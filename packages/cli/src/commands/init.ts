import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUT_DIR, detect } from '@jsxray/core';
import { flagBoolean, type ParsedArgs } from '../args.js';

export async function initCommand(args: ParsedArgs): Promise<number> {
  const root = path.resolve(process.cwd());
  const target = path.join(root, 'jsxray.config.ts');

  if (fs.existsSync(target) && !flagBoolean(args.flags, 'force')) {
    process.stderr.write('jsxray.config.ts already exists. Pass --force to overwrite.\n');
    return 1;
  }

  const profile = detect(root);
  fs.writeFileSync(target, scaffold(profile.routerRoot, profile.router));
  appendGitignore(root);

  process.stdout.write(
    `wrote   jsxray.config.ts\nstack   ${[profile.ui, profile.metaFramework, profile.router]
      .filter(Boolean)
      .join(' · ')}\n\nSet your credential env vars, then run \`jsxray run\`.\n`,
  );
  return 0;
}

function scaffold(routerRoot: string | null, router: string | null): string {
  return `import { defineConfig, env } from '@jsxray/core';

// Detected: ${router ?? 'no supported router'}${routerRoot ? ` at ${routerRoot}` : ''}
// jsxray never boots your app — point it at a URL you are already serving.
// Screenshots capture real authenticated data: use a test account with nothing sensitive in it.

export default defineConfig({
  url: 'http://localhost:3000',

  personas: [
    { id: 'anon' },
    // { id: 'user', login: { username: env('USER_EMAIL'), password: env('USER_PW') } },
  ],

  // loginFlow: {
  //   start: '/login',
  //   steps: [
  //     { fill: { '[name="email"]': '{{username}}', '[name="password"]': '{{password}}' } },
  //     { submit: 'button[type="submit"]' },
  //   ],
  // },

  seedRoutes: ['/'],

  ignore: {
    navigation: [],                        // never click through to these
    actions: [],                           // visit and capture, but do not interact
    screenshots: [],                       // visit and interact, but never capture — privacy
  },
});
`;
}

function appendGitignore(root: string): void {
  const file = path.join(root, '.gitignore');
  const entry = `${DEFAULT_OUT_DIR}/`;
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.split('\n').some((line) => line.trim() === entry)) return;
    fs.writeFileSync(file, `${current}${current.endsWith('\n') || !current ? '' : '\n'}${entry}\n`);
  } catch {
    /* a missing .gitignore is not a reason to fail init */
  }
}
