import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadSessionBoundary, headerValue, requestUrl, sendJson } from './read-session.js';
import { SCOPED_CONSOLE_ID_RE } from './bounded-read-worker.js';
import {
  applyScopedConsoleSecurityHeaders, isLoopbackPortHost, listenLoopbackServer, serveScopedConsoleAsset,
} from './scoped-console-http.js';
import { createUniverseConsoleReader, validateUniverseConsoleRoot } from './universe-console-reads.js';
import type { UniverseConsoleServerHandle, UniverseConsoleServerOptions } from './universe-console-types.js';
export type { UniverseConsoleServerHandle, UniverseConsoleServerOptions } from './universe-console-types.js';

function singleIdQueryParam(url: URL, name: string): string | null {
  const ids = url.searchParams.getAll(name);
  if (ids.length !== 1 || !SCOPED_CONSOLE_ID_RE.test(ids[0]!)
    || [...url.searchParams.keys()].some((key) => key !== name)) return null;
  return ids[0]!;
}

function sendProjection(res: ServerResponse, json: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(json, 'utf8') });
  res.end(json);
}

/** Config-free, foreground-only reader for exactly one caller-selected Universe store. */
export async function startUniverseConsoleServer(options: UniverseConsoleServerOptions): Promise<UniverseConsoleServerHandle> {
  const root = validateUniverseConsoleRoot(options.root);
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid Universe console port');
  const reader = createUniverseConsoleReader(root);
  const sessions = createReadSessionBoundary({ cookieName: `ashlr_universe_${randomBytes(12).toString('hex')}` });
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'public');
  let origin = '';
  let boundPort = 0;
  let closing: Promise<void> | null = null;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyScopedConsoleSecurityHeaders(res);
    if (!isLoopbackPortHost(headerValue(req, 'host'), boundPort)) {
      sendJson(res, 403, { error: 'Forbidden: invalid Host header' }); return;
    }
    // Native raw-header clients need no Origin. Browser requests must match the
    // advertised origin exactly; no trusted proxy or permissive CORS mode exists.
    if (req.headers.origin !== undefined && headerValue(req, 'origin') !== origin) {
      sendJson(res, 403, { error: 'Forbidden: invalid Origin header' }); return;
    }
    const url = requestUrl(req);
    if (!url) { sendJson(res, 400, { error: 'Invalid request URL' }); return; }
    const method = (req.method ?? 'GET').toUpperCase();
    if (url.pathname === '/health') {
      if (url.search) { sendJson(res, 400, { error: 'Health does not accept query parameters' }); return; }
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      sendJson(res, 200, { ok: true }); return;
    }
    if (sessions.handleSession(req, res, url)) return;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!sessions.authority(req, url)) {
        sendJson(res, 401, { error: 'Unauthorized: read session required' },
          { Vary: 'Cookie, X-Ashlr-Token, X-Ashlr-Read-Client' }); return;
      }
      if (method !== 'GET') { sendJson(res, 405, { error: 'Read-only API' }); return; }
      if (url.pathname === '/api/universe/console' || url.pathname === '/api/universe') {
        if (url.search) { sendJson(res, 400, { error: 'This route does not accept query parameters' }); return; }
        if (url.pathname.endsWith('/console')) {
          // Explicit authenticated scope metadata, not a inferred/default home.
          sendJson(res, 200, { schemaVersion: 1, mode: 'universe', root, readOnly: true });
        } else sendProjection(res, await reader.overview());
        return;
      }
      const idRoutes: ReadonlyArray<readonly [string, string, (id: string) => Promise<string>]> = [
        ['/api/universe/graph', 'universeId', (id) => reader.graph(id)],
        ['/api/universe/campaign-readiness', 'campaignId', (id) => reader.campaignReadiness(id)],
        ['/api/universe/controller-status', 'controllerId', (id) => reader.controllerStatus(id)],
      ];
      const matched = idRoutes.find(([pathname]) => pathname === url.pathname);
      if (matched) {
        const [, param, read] = matched;
        const id = singleIdQueryParam(url, param);
        if (!id) { sendJson(res, 400, { error: `Expected exactly one ${param} and no other parameters` }); return; }
        sendProjection(res, await read(id)); return;
      }
      sendJson(res, 404, { error: 'Route unavailable in this scoped console' }); return;
    }
    if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    if (url.search) { sendJson(res, 400, { error: 'Static resources do not accept query parameters' }); return; }
    if (url.pathname === '/universe') { res.writeHead(308, { Location: '/universe/' }); res.end(); return; }
    // Reuse packaged assets without ASHLR_WEB_PUBLIC or a caller-selected path.
    if (serveScopedConsoleAsset(req, res, url.pathname, '/universe/', assets)) return;
    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    if (closing) { sendJson(res, 503, { error: 'Console is closing' }); return; }
    void route(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 503, { error: 'Universe evidence is temporarily unavailable' });
      else if (!res.writableEnded) res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    ({ port: boundPort, origin } = await listenLoopbackServer(server, requestedPort, 'Console address is unavailable'));
  } catch (error) {
    await reader.close(); sessions.clear(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
  return { url: origin, consoleUrl: `${origin}/universe/`, port: boundPort, readToken: sessions.readToken,
    close() {
      if (closing) return closing;
      sessions.clear();
      closing = Promise.all([reader.close(), new Promise<void>((done) => {
        server.close(() => done()); server.closeIdleConnections(); server.closeAllConnections();
      })]).then(() => undefined);
      return closing;
    } };
}
