#!/usr/bin/env node
import { parseArgs } from './args.js';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { viewCommand } from './commands/view.js';
import { packageVersion } from './paths.js';

const HELP = `jsxray ${packageVersion()}

  jsxray run     source -> .jsxray/jsxray.json, then drive the app -> captures
  jsxray view    open the canvas over the document
  jsxray init    scaffold jsxray.config.ts from the detected stack

run   -c/--config  -u/--url  -o/--out  -s/--stages  --static-only
      --persona  --headed  --max-states  --timeout  -q/--quiet
view  -c/--config  -f/--file  -o/--out  -p/--port  -l/--list  -e/--export  --no-open
init  -f/--force
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  switch (args.command) {
    case 'run':
      return runCommand(args);
    case 'view':
      return viewCommand(args);
    case 'init':
      return initCommand(args);
    default:
      process.stdout.write(HELP);
      return args.command ? 1 : 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
