import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publishPage, readPage } from '../src/core/cos/pages.js';
import { startServer } from '../src/core/web/server.js';
import type { AshlrConfig, WebServerHandle } from '../src/core/types.js';

const transport = vi.hoisted(() => ({ server: null as import('node:http').Server | null }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => {
    transport.server = actual.createServer(...args);
    return transport.server;
  } };
});

let handle: WebServerHandle | undefined;
let home: string | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

it('serves published pages only with read authority and refuses API writes', async () => {
  home = mkdtempSync(join(tmpdir(), 'phantom-pages-http-'));
  vi.stubEnv('ASHLR_HOME', home);
  const source = join(home, 'weekly.md');
  writeFileSync(source, '# Weekly report\n\nLocal report body.');
  expect(publishPage({ filePath: source }).ok).toBe(true);
  const config: AshlrConfig = {
    version: 1, roots: [], editor: 'cursor', staleDays: 30,
    categories: {}, tidyRules: [], keepers: [], telemetry: {}, tools: {},
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: ['ollama'] },
  };
  handle = await startServer(config, { port: 0, open: false, allowDispatch: false }, { readProjections: null });
  // Dispatch real HTTP request/response objects in process: this host refuses
  // outbound loopback sockets (EPERM), while the server boundary is testable.
  const get = (path: string, token?: string, method = 'GET'): Promise<{ status: number; body: string; location: string | undefined }> =>
    new Promise((resolve) => {
      const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
      const req = new IncomingMessage(socket);
      req.url = path;
      req.method = method;
      req.headers = { host: `127.0.0.1:${handle!.port}`, ...(token ? { 'x-ashlr-token': token } : {}) };
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      let body = '';
      let location: string | undefined;
      const writeHead = res.writeHead.bind(res);
      vi.spyOn(res, 'writeHead').mockImplementation(((status: number, headers?: import('node:http').OutgoingHttpHeaders) => {
        const value = headers?.Location;
        if (typeof value === 'string') location = value;
        return writeHead(status, headers);
      }) as typeof res.writeHead);
      const end = res.end.bind(res);
      vi.spyOn(res, 'end').mockImplementation(((chunk?: unknown) => {
        if (chunk !== undefined) body += String(chunk);
        return end(chunk);
      }) as typeof res.end);
      res.once('finish', () => {
        socket.destroy();
        resolve({ status: res.statusCode, body, location: typeof location === 'string' ? location : undefined });
      });
      transport.server!.emit('request', req, res);
    });
  for (const path of ['/api/pages', '/api/pages/weekly']) {
    const denied = await get(path);
    expect(denied.status).toBe(401);
    expect(denied.body).not.toContain('Weekly report');
  }
  const link = await get('/pages/weekly');
  expect(link.status).toBe(302);
  expect(link.location).toBe('/next/#/pages/weekly');
  const list = await get('/api/pages', handle.readToken);
  expect(list.status).toBe(200);
  expect(JSON.parse(list.body)).toMatchObject({ count: 1, pages: [{ slug: 'weekly' }] });
  const detail = await get('/api/pages/weekly', handle.readToken);
  expect(detail.status).toBe(200);
  expect(JSON.parse(detail.body)).toMatchObject({ title: 'Weekly report', markdown: '# Weekly report\n\nLocal report body.' });
  expect((await get('/api/pages/missing', handle.readToken)).status).toBe(404);
  expect((await get('/api/pages/weekly', handle.readToken, 'POST')).status).toBeGreaterThanOrEqual(400);
  expect(readPage('weekly')?.markdown).toBe('# Weekly report\n\nLocal report body.');
});
