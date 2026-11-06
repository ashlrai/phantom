import type { IncomingMessage, ServerResponse } from 'node:http';
import { readGrokUltraRunway } from '../fleet/grok-ultra-store.js';
import { sendJson } from '../web/api.js';

export const GROK_ULTRA_PATH = '/api/verse/fleet/grok-ultra';

/** Server/remote read-session authentication precedes dispatch. No writes or telemetry. */
export async function handleGrokUltraApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== GROK_ULTRA_PATH) return false;
  if (method !== 'GET') { sendJson(res, 404, { error: 'Grok usage is read only.' }); return true; }
  if (new URL(req.url ?? path, 'http://localhost').search) {
    sendJson(res, 400, { error: 'Grok usage does not accept query parameters.' }); return true;
  }
  sendJson(res, 200, await readGrokUltraRunway());
  return true;
}
