/**
 * Durable local bus, shared with `phm comms bus`:
 * GET /api/verse/agent-bus[?after=0&limit=50] reads a cursor page (limit 1..100).
 * POST /api/verse/agent-bus appends exactly one BusEnvelope, with the normal
 * dispatch/token gate. GET /api/verse/agent-bus/status inspects retained capacity.
 * GETs require a current read session. Responses wrap store outcomes with v: 1;
 * missing storage reads as an empty page, while status reports source: missing.
 * Unavailable storage returns 503. Expired rows advance nextCursor but are omitted.
 * Address labels are routing data, not authenticated sender or recipient identities.
 * sendJson sanitizes returned data, so HTTP output is not necessarily byte-identical
 * to the stored envelope. No caller may choose the storage root or clock.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseBusEnvelope } from '../fleet/bus-envelope.js';
import { appendBusInbox, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

const PATH = '/api/verse/agent-bus';
export interface AgentBusApiDeps {
  append?: typeof appendBusInbox;
  list?: typeof listBusInboxAfter;
  inspect?: typeof inspectBusInbox;
}

/** Dependencies permit isolated store tests; the public handler uses the default store. */
export function createAgentBusApi(deps: AgentBusApiDeps = {}): ApiModule {
  return async (ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
    if (path !== PATH && path !== `${PATH}/status`) return false;
    if (method !== 'GET' && !(method === 'POST' && path === PATH)) {
      sendJson(res, 404, { error: 'not found' }); return true;
    }
    if (method === 'GET' && (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now())) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    if (method === 'POST') {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
    }
    let params: URLSearchParams;
    try { params = new URL(req.url ?? path, 'http://localhost').searchParams; }
    catch { sendJson(res, 400, { error: 'Invalid query.' }); return true; }
    const allowed = method === 'GET' && path === PATH ? ['after', 'limit'] : [];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) {
      sendJson(res, 400, { error: 'Invalid query.' }); return true;
    }
    try {
      if (method === 'GET' && path === `${PATH}/status`) {
        const result = (deps.inspect ?? inspectBusInbox)();
        sendJson(res, result.source === 'unavailable' ? 503 : 200, { v: 1, ...result });
      } else if (method === 'GET') {
        const after = params.get('after') ?? '0', limit = params.get('limit') ?? '50';
        if (![after, limit].every(value => /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))) ||
          Number(limit) < 1 || Number(limit) > BUS_INBOX_MAX_READ) {
          sendJson(res, 400, { error: 'Invalid cursor or limit.' }); return true;
        }
        const result = (deps.list ?? listBusInboxAfter)(Number(after), Number(limit));
        sendJson(res, result.status === 'ok' ? 200 : result.status === 'invalid' ? 400 : 503, { v: 1, ...result });
      } else {
        let raw: string;
        try { raw = await readBody(req); } catch { sendJson(res, 413, { error: 'Request body too large.' }); return true; }
        const parsed = parseBusEnvelope(raw);
        if (!parsed.ok) { sendJson(res, 400, { v: 1, status: 'invalid' }); return true; }
        const result = (deps.append ?? appendBusInbox)(parsed.value);
        const status = result.status === 'posted' ? 201 : result.status === 'duplicate' ? 200 :
          result.status === 'invalid' ? 400 : result.status === 'conflict' ? 409 : result.status === 'full' ? 507 : 503;
        sendJson(res, status, { v: 1, ...result });
      }
    } catch { sendJson(res, 503, { v: 1, status: 'unavailable' }); }
    return true;
  };
}
export const handleAgentBusApi = createAgentBusApi();
