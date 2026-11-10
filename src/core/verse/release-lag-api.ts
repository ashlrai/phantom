import type { IncomingMessage, ServerResponse } from 'node:http';
import { readReleaseLag, type ReleaseLagV1 } from '../release/lag.js';
import { sendJson } from '../web/api.js';

export const RELEASE_LAG_PATH = '/api/verse/fleet/release-lag';
const TTL_MS = 60_000;
let cached: { at: number; read: Promise<ReleaseLagV1> } | null = null;

/** Read-only. Reads are shared for a minute so Fleet polling does not hammer GitHub. */
export async function handleReleaseLagApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (path !== RELEASE_LAG_PATH) return false;
  if (method !== 'GET') { sendJson(res, 404, { error: 'Release lag is read only.' }); return true; }
  if (new URL(req.url ?? path, 'http://localhost').search) {
    sendJson(res, 400, { error: 'Release lag does not accept query parameters.' }); return true;
  }
  if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), read: readReleaseLag() };
  sendJson(res, 200, await cached.read);
  return true;
}
