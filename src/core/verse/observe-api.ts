/**
 * GET /api/verse/observe, GET /api/verse/observe/session?id= and read-only GET /api/verse/intent.
 * The desktop panes read the same snapshot as `phm observe --json`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { emptyLedger } from '../intent/schema.js';
import { summarize } from '../intent/summary.js';
import { ledgerFilePresent, readLedger } from '../intent/store.js';
import { readObserveSession, readObserveSnapshot } from '../observe/read.js';
import { readWorldModel } from '../world/read.js';

export const OBSERVE_PATH = '/api/verse/observe';
export const OBSERVE_SESSION_PATH = '/api/verse/observe/session';
export const WORLD_PATH = '/api/verse/world';
export const INTENT_PATH = '/api/verse/intent';

export function isObservePath(path: string): boolean {
  return path === OBSERVE_PATH || path === OBSERVE_SESSION_PATH || path === WORLD_PATH || path === INTENT_PATH;
}

function queryId(req: IncomingMessage): string | null {
  const raw = req.url ?? '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const id = new URLSearchParams(query).get('id');
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null;
}

/** One ledger read feeds both the summary and the records so counts always match them. */
async function readIntentPayload(): Promise<{ status: number; body: unknown }> {
  try {
    const present = await ledgerFilePresent();
    const ledger = present ? await readLedger() : emptyLedger();
    return { status: 200, body: { ok: true, ...summarize(ledger, Date.now(), present), records: ledger.items } };
  } catch {
    return { status: 503, body: { ok: false, error: 'intent ledger unavailable', records: [] } };
  }
}

export async function handleObserveApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!isObservePath(path)) return false;
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  if (path === WORLD_PATH) {
    sendJson(res, 200, await readWorldModel());
    return true;
  }
  if (path === INTENT_PATH) {
    const intent = await readIntentPayload();
    sendJson(res, intent.status, intent.body);
    return true;
  }
  if (path === OBSERVE_SESSION_PATH) {
    const id = queryId(req);
    if (!id) {
      sendJson(res, 400, { error: 'session id is required' });
      return true;
    }
    sendJson(res, 200, await readObserveSession(id));
    return true;
  }
  sendJson(res, 200, await readObserveSnapshot());
  return true;
}
