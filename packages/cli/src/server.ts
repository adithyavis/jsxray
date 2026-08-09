import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ASSET_DIRNAME, DOCUMENT_FILENAME } from '@jsxray/core';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface ServeOptions {
  documentFile: string;
  assetsDir: string;
  viewerDir: string;
  port: number;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions): Promise<RunningServer> {
  const server = http.createServer((request, response) => {
    handle(request, response, options).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('internal error');
    });
  });

  // No single request ends the session (§15).
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => undefined);

  const port = await listen(server, options.port);
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: ServeOptions,
): Promise<void> {
  const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0]!);

  if (requestPath === `/${DOCUMENT_FILENAME}`) {
    await sendFile(response, options.documentFile);
    return;
  }

  if (requestPath.startsWith(`/${ASSET_DIRNAME}/`)) {
    const file = safeJoin(options.assetsDir, requestPath.slice(ASSET_DIRNAME.length + 2));
    if (!file) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    await sendFile(response, file);
    return;
  }

  const candidate = safeJoin(options.viewerDir, requestPath.replace(/^\//, ''));
  if (!candidate) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }

  if (await isReadableFile(candidate)) {
    await sendFile(response, candidate);
    return;
  }

  // Unknown paths fall back to the SPA shell.
  await sendFile(response, path.join(options.viewerDir, 'index.html'));
}

/** Rejects anything that escapes the served root, in any encoding. */
function safeJoin(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null;
  return target;
}

/** §15 — headers are not written until the file is known readable. */
async function sendFile(response: http.ServerResponse, file: string): Promise<void> {
  let size: number;
  try {
    const stats = await fs.promises.stat(file);
    if (!stats.isFile()) throw new Error('not a file');
    await fs.promises.access(file, fs.constants.R_OK);
    size = stats.size;
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });

  const stream = fs.createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

async function isReadableFile(file: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(file);
    return stats.isFile();
  } catch {
    return false;
  }
}

function listen(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, remaining: number): void => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && remaining > 0) attempt(port + 1, remaining - 1);
        else reject(error);
      });
      server.listen(port, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    };
    attempt(preferred, 20);
  });
}
