/** GET /api/verse/whats-new?version=x.y.z — the release's CHANGELOG bullets, read-only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { readInstalledChangelog, WHATS_NEW_VERSION } from './changelog-read.js';

export const VERSE_WHATS_NEW_PATH = '/api/verse/whats-new';

export interface WhatsNewResponse { version: string; bullets: string[] | null }

export function handleWhatsNewApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  read: (version: string) => string[] | null = readInstalledChangelog,
): boolean {
  if (path !== VERSE_WHATS_NEW_PATH) return false;
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  let version: string | null = null;
  try { version = new URL(req.url ?? path, 'http://localhost').searchParams.get('version'); } catch { /* 400 below */ }
  if (version === null || !WHATS_NEW_VERSION.test(version)) {
    sendJson(res, 400, { error: 'version must look like 1.2.3' });
    return true;
  }
  const bullets = read(version);
  const body: WhatsNewResponse = { version, bullets: bullets !== null && bullets.length > 0 ? bullets : null };
  sendJson(res, 200, body);
  return true;
}
