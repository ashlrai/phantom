import type { IncomingMessage, ServerResponse } from 'node:http';
import { passesMutationGate, readBody, sendJson } from '../web/api-http-helpers.js';
import { POOL_READING_PATH, setPoolReading, showPoolReadings } from '../usage/pool-reading.js';

export async function handlePoolReadingApi(req: IncomingMessage, res: ServerResponse,
  ctx: { token: string; allowDispatch: boolean }): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== POOL_READING_PATH) return false;
  if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); sendJson(res, 405, { error: 'Use GET or POST' }); return true; }
  if (req.method === 'POST') {
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
  }
  try {
    if ([...url.searchParams.keys()].some(key => key !== 'pool') || url.searchParams.getAll('pool').length > 1
      || (req.method === 'POST' && url.search)) throw new Error('Only GET accepts one optional pool query');
    sendJson(res, 200, req.method === 'GET' ? await showPoolReadings(url.searchParams.get('pool') ?? undefined)
      : await setPoolReading(JSON.parse(await readBody(req, 4096))));
  } catch (error) { sendJson(res, (error as NodeJS.ErrnoException).code ? 503 : 400, { error: 'Invalid reading: use pool, pct (0–100), future reset_at (ISO or Unix seconds), and source; capture time is automatic.' }); }
  return true;
}
