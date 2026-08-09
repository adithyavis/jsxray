import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type RunningServer } from '../src/server.js';

let root: string;
let server: RunningServer;
let documentFile: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsxray-serve-'));
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'viewer'), { recursive: true });
  documentFile = path.join(root, 'jsxray.json');

  fs.writeFileSync(documentFile, '{"schemaVersion":1}');
  fs.writeFileSync(path.join(root, 'assets', 'home.png'), 'png-bytes');
  fs.writeFileSync(path.join(root, 'viewer', 'index.html'), '<!doctype html><title>shell</title>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'must never be served');

  server = await serve({
    documentFile,
    assetsDir: path.join(root, 'assets'),
    viewerDir: path.join(root, 'viewer'),
    port: 0,
  });
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('view server', () => {
  it('serves the document and its assets', async () => {
    const document = await fetch(`${server.url}/jsxray.json`);
    expect(document.status).toBe(200);
    expect(document.headers.get('content-type')).toContain('application/json');

    const capture = await fetch(`${server.url}/assets/home.png`);
    expect(capture.status).toBe(200);
    expect(capture.headers.get('content-type')).toBe('image/png');
  });

  it('falls back to the SPA shell for unknown paths', async () => {
    const response = await fetch(`${server.url}/anything/at/all`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('shell');
  });

  it('never serves a file outside a served root, in any encoding', async () => {
    const escapes = [
      '/assets/../secret.txt',
      '/assets/%2e%2e%2fsecret.txt',
      '/assets/..%252fsecret.txt',
      '/viewer/../secret.txt',
    ];
    for (const escape of escapes) {
      const response = await fetch(`${server.url}${escape}`);
      expect(await response.text()).not.toContain('must never be served');
    }
  });

  it('rejects a raw traversal the client never normalizes away', async () => {
    const response = await rawRequest(server.url, '/assets/../secret.txt');
    expect(response).toMatch(/^HTTP\/1\.1 403/);
    expect(response).not.toContain('must never be served');
  });

  it('survives the document being deleted mid-session', async () => {
    fs.rmSync(documentFile);
    const missing = await fetch(`${server.url}/jsxray.json`);
    expect(missing.status).toBe(404);

    const stillUp = await fetch(`${server.url}/assets/home.png`);
    expect(stillUp.status).toBe(200);

    fs.writeFileSync(documentFile, '{"schemaVersion":1}');
    expect((await fetch(`${server.url}/jsxray.json`)).status).toBe(200);
  });
});

/** fetch() normalizes `..` before it leaves the client, so the server needs its own proof. */
function rawRequest(baseUrl: string, requestPath: string): Promise<string> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let received = '';
    socket.on('data', (chunk) => (received += chunk));
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });
}
