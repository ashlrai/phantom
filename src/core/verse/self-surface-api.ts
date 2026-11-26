/**
 * core/verse/self-surface-api.ts — the loopback routes of the self-surface
 * (core/verse/self-surface.ts), mounted by verse-api.ts.
 *
 *   POST /api/verse/self/request  agent → {verb, ...}; the scoped self token
 *                                 (x-ashlr-self-token) or the console mutation
 *                                 token; a browser Origin is refused. Answers
 *                                 the SelfResult once the window has run it.
 *   GET  /api/verse/self/next     the desktop webview's long poll (read session)
 *   POST /api/verse/self/result   the webview's answer (mutation gate, applied
 *                                 by verse-api.ts before this module runs)
 */
import { timingSafeEqual } from 'node:crypto';
import { readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { SELF_NEXT_PATH, SELF_REQUEST_PATH, SELF_RESULT_PATH, SELF_TOKEN_HEADER, selfSurfaceBroker, selfTokenMatches, type SelfSurfaceBroker } from './self-surface.js';

const MAX_RESULT_BYTES = 12 * 1024 * 1024;

function header(req: Parameters<ApiModule>[1], name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameToken(value: string | undefined, token: string): boolean {
  if (typeof value !== 'string' || value.length !== token.length || token.length === 0) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

export function createSelfSurfaceApi(getBroker: () => SelfSurfaceBroker = selfSurfaceBroker): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== SELF_REQUEST_PATH && path !== SELF_NEXT_PATH && path !== SELF_RESULT_PATH) return false;
    const broker = getBroker();
    if (path === SELF_NEXT_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const wait = Number(new URL(req.url ?? '', 'http://localhost').searchParams.get('wait') ?? '25000');
      const aborted = new AbortController();
      res.once('close', () => aborted.abort());
      const command = await broker.next(Number.isFinite(wait) ? wait : 25_000, aborted.signal);
      if (!res.writableEnded && !aborted.signal.aborted) sendJson(res, 200, { command });
      return true;
    }
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    let body: unknown;
    try { body = JSON.parse(await readBody(req, path === SELF_RESULT_PATH ? MAX_RESULT_BYTES : 4_096)); }
    catch { sendJson(res, 400, { error: 'Send one JSON object.' }); return true; }
    if (path === SELF_RESULT_PATH) {
      const r = body && typeof body === 'object' ? body as { id?: unknown; result?: unknown } : {};
      if (typeof r.id !== 'string' || !broker.complete(r.id, r.result)) sendJson(res, 404, { error: 'No pending self-surface request with that id.' });
      else sendJson(res, 200, { ok: true });
      return true;
    }
    // A page in a browser must never drive this route, whatever it holds.
    if (header(req, 'origin')) { sendJson(res, 403, { error: 'Browser origins are refused.' }); return true; }
    if (!selfTokenMatches(header(req, SELF_TOKEN_HEADER)) && !sameToken(header(req, 'x-ashlr-token'), ctx.token)) {
      sendJson(res, 401, { error: `unauthorized: missing or invalid ${SELF_TOKEN_HEADER}` });
      return true;
    }
    const result = await broker.submit(body);
    sendJson(res, result.ok || result.code !== 'invalid' ? 200 : 400, result);
    return true;
  };
}

export const handleSelfSurfaceApi: ApiModule = createSelfSurfaceApi();
