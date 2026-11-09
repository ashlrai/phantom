/**
 * GET /api/verse/observe and GET /api/verse/observe/session?id=
 * The desktop panes read the same snapshot as `phm observe --json`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { readObserveSession, readObserveSnapshot } from '../observe/read.js';

export const OBSERVE_PATH = '/api/verse/observe';
export const OBSERVE_SESSION_PATH = '/api/verse/observe/session';

export function isObservePath(path: string): boolean {
  return path === OBSERVE_PATH || path === OBSERVE_SESSION_PATH;
}

function queryId(req: IncomingMessage): string | null {
  const raw = req.url ?? '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const id = new URLSearchParams(query).get('id');
  return id && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : null;
}

export async function handleObserveApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!isObservePath(path)) return false;
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
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
