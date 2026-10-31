import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { KnowledgeGraph } from '../core/types.js';
import { headerValue, safeEqual, sendJson } from '../core/web/read-session.js';

export interface GraphHttpOptions {
  /** Only the literal IPv4 loopback address is accepted; DNS is never used. */
  host?: string;
  /** Defaults to an ephemeral port. */
  port?: number;
}

export interface GraphHttpHandle {
  url: string;
  port: number;
  /** Process-local read capability, sent only in X-Ashlr-Token. Keep private. */
  readToken: string;
  close(): Promise<void>;
}

export interface GraphHttpDependencies {
  /** Embedders may supply a read-only projection; default: enrolled knowledge graph. */
  readGraph?: () => KnowledgeGraph | Promise<KnowledgeGraph>;
}

/** Start an independent, read-only graph listener without dashboard or dispatch services. */
export async function startGraphServer(
  options: GraphHttpOptions = {},
  dependencies: GraphHttpDependencies = {},
): Promise<GraphHttpHandle> {
  if (options.host !== undefined && options.host !== '127.0.0.1') {
    throw new Error('Graph HTTP must bind to 127.0.0.1');
  }
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('Invalid graph HTTP port');
  }
  const readGraph = dependencies.readGraph ?? (async () => {
    const { buildGraph } = await import('../core/knowledge/graph.js');
    return buildGraph();
  });
  const readToken = randomBytes(32).toString('hex');
  let origin = '';
  let boundPort = 0;
  let closing: Promise<void> | null = null;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // Loopback binding alone does not prevent DNS rebinding or browser reads.
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(headerValue(req, 'host'))) {
      sendJson(res, 403, { error: 'Forbidden: invalid Host header' }); return;
    }
    if ((req.headers.origin !== undefined && headerValue(req, 'origin') !== origin)
      || headerValue(req, 'sec-fetch-site') === 'cross-site') {
      sendJson(res, 403, { error: 'Forbidden: cross-origin request' }); return;
    }
    // Cookies and query parameters never confer authority on this listener.
    if (!safeEqual(headerValue(req, 'x-ashlr-token'), readToken)) {
      sendJson(res, 401, { error: 'Unauthorized: read token required' }); return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Read-only API' }, { Allow: 'GET' }); return;
    }
    // Match the raw origin-form target: URL normalization must not turn dot
    // segments or an absolute proxy URL into a different graph request.
    const target = req.url ?? '';
    if (!target.startsWith('/') || target.startsWith('//') || target.includes('?') || target.includes('#')) {
      sendJson(res, 400, { error: 'Expected a graph path without query parameters' }); return;
    }
    let nodeId: string | undefined;
    if (target !== '/graph') {
      const match = /^\/graph\/nodes\/([^/]+)$/.exec(target);
      if (!match) { sendJson(res, 404, { error: 'Not found' }); return; }
      try { nodeId = decodeURIComponent(match[1]!); }
      catch { sendJson(res, 400, { error: 'Invalid node ID encoding' }); return; }
      if (!nodeId || /\p{Cc}/u.test(nodeId)) {
        sendJson(res, 400, { error: 'Invalid node ID' }); return;
      }
    }
    const graph = await readGraph();
    if (res.destroyed) return;
    if (nodeId === undefined) { sendJson(res, 200, graph); return; }
    // IDs are opaque, decoded exactly once, and never used as filesystem paths.
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) { sendJson(res, 404, { error: 'Node not found' }); return; }
    sendJson(res, 200, node);
  }

  const server = createServer((req, res) => {
    if (closing) { sendJson(res, 503, { error: 'Graph HTTP is closing' }); return; }
    void route(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 503, { error: 'Graph is temporarily unavailable' });
      } else if (!res.writableEnded) res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => { server.removeListener('listening', ready); reject(error); };
    const ready = (): void => { server.removeListener('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(requestedPort, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Graph HTTP address is unavailable');
  }
  boundPort = address.port;
  origin = `http://127.0.0.1:${boundPort}`;
  return {
    url: origin, port: boundPort, readToken,
    close() {
      if (!closing) {
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
