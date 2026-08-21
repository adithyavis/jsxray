import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SCHEMA_VERSION, loadConfig, type JsxrayDocument } from '@jsxray/core';
import { flagBoolean, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { assetDir, documentPath, viewerBundleDir } from '../paths.js';
import { serve } from '../server.js';
import { listDocument } from '../list.js';

export async function viewCommand(args: ParsedArgs): Promise<number> {
  const root = path.resolve(process.cwd());
  const config = await loadConfig(root, flagString(args.flags, 'config'));
  const outDir = path.resolve(root, flagString(args.flags, 'out') ?? config.out);
  const file = flagString(args.flags, 'file')
    ? path.resolve(root, flagString(args.flags, 'file')!)
    : documentPath(outDir);

  if (!fs.existsSync(file)) {
    process.stderr.write(`No document at ${path.relative(root, file)}. Run \`jsxray run\` first.\n`);
    return 1;
  }

  const document = JSON.parse(fs.readFileSync(file, 'utf8')) as JsxrayDocument;
  if (document.schemaVersion !== SCHEMA_VERSION) {
    process.stderr.write(
      `Document schemaVersion ${document.schemaVersion}, this build reads ${SCHEMA_VERSION}. Re-run \`jsxray run\`.\n`,
    );
    return 1;
  }

  if (flagBoolean(args.flags, 'list')) {
    process.stdout.write(listDocument(document));
    return 0;
  }

  const exportTo = flagString(args.flags, 'export');
  if (exportTo) return exportSingleFile(document, path.dirname(file), path.resolve(root, exportTo));

  const viewerDir = viewerBundleDir('dist');
  if (!viewerDir) {
    process.stderr.write('Viewer bundle not found. Run `npm run build` first.\n');
    return 1;
  }

  const server = await serve({
    documentFile: file,
    assetsDir: assetDir(path.dirname(file)),
    viewerDir,
    port: flagNumber(args.flags, 'port') ?? 4321,
  });

  process.stdout.write(`jsxray  ${server.url}\n`);
  if (flagBoolean(args.flags, 'open', true)) openBrowser(server.url);
  await new Promise(() => undefined);
  return 0;
}

/** One self-contained file: the shell, the document, and the captures as data URIs. */
function exportSingleFile(
  document: JsxrayDocument,
  documentDir: string,
  target: string,
): number {
  const singleDir = viewerBundleDir('dist-single');
  if (!singleDir) {
    process.stderr.write('Single-file viewer bundle not found. Run `npm run build` first.\n');
    return 1;
  }

  const inlined = structuredClone(document);
  for (const state of inlined.states) {
    // §7.8 — every viewport's picture travels, so the toggle works offline too.
    state.captures = state.captures.filter((capture) => {
      const source = path.resolve(documentDir, capture.path);
      try {
        capture.path = `data:image/png;base64,${fs.readFileSync(source).toString('base64')}`;
        return true;
      } catch {
        return false;
      }
    });
    if (!state.captures.length && state.captureStatus === 'ok') state.captureStatus = 'failed';
  }

  const shell = fs.readFileSync(path.join(singleDir, 'index.html'), 'utf8');
  const payload = `<script>window.__JSXRAY__=${JSON.stringify(inlined).replace(
    /</g,
    '\\u003c',
  )}</script>`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, shell.replace('</head>', `${payload}</head>`));
  process.stdout.write(`wrote   ${target}\n`);
  return 0;
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening a browser is a convenience, never a failure */
  }
}
