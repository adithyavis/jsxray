import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, run as runPipeline, type StageName } from '@jsxray/core';
import { registry } from '@jsxray/providers';
import { flagBoolean, flagList, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { documentPath, packageVersion } from '../paths.js';

const STAGE_NAMES: StageName[] = ['detect', 'parse', 'enumerate', 'crawl', 'link'];

export async function runCommand(args: ParsedArgs): Promise<number> {
  const root = path.resolve(process.cwd());
  const quiet = flagBoolean(args.flags, 'quiet');
  const log = (message: string) => {
    if (!quiet) process.stdout.write(`${message}\n`);
  };

  const config = await loadConfig(root, flagString(args.flags, 'config'));
  const outDir = path.resolve(root, flagString(args.flags, 'out') ?? config.out);

  const stageList = flagList(args.flags, 'stages');
  const unknownStage = stageList?.find((stage) => !STAGE_NAMES.includes(stage as StageName));
  if (unknownStage) {
    process.stderr.write(`Unknown stage "${unknownStage}". Known: ${STAGE_NAMES.join(', ')}\n`);
    return 1;
  }

  const maxStates = flagNumber(args.flags, 'max-states');
  const timeout = flagNumber(args.flags, 'timeout');
  if (maxStates !== null) config.bounds.maxStates = maxStates;
  if (timeout !== null) config.bounds.timeoutMs = timeout * 1000;

  const document = await runPipeline({
    root,
    outDir,
    config,
    registry,
    version: packageVersion(),
    stages: (stageList as StageName[] | null) ?? null,
    staticOnly: flagBoolean(args.flags, 'static-only'),
    headed: flagBoolean(args.flags, 'headed'),
    personaIds: flagList(args.flags, 'persona'),
    url: flagString(args.flags, 'url'),
    log,
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(documentPath(outDir), `${JSON.stringify(document, null, 2)}\n`);

  const errors = document.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
  const warnings = document.diagnostics.filter((diagnostic) => diagnostic.level === 'warn');
  log(`\nwrote   ${path.relative(root, documentPath(outDir))}`);
  if (warnings.length || errors.length) {
    log(`        ${errors.length} errors, ${warnings.length} warnings`);
    for (const diagnostic of [...errors, ...warnings].slice(0, 10)) {
      log(`  ${diagnostic.level}  ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  return errors.length ? 1 : 0;
}
