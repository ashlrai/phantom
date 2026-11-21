/**
 * GET /api/verse/whats-new?version=x.y.z — the release's CHANGELOG bullets, read-only.
 * GET /api/verse/shipped?days=7 — the weekly "what shipped" report, the same one `phm shipped --json` prints.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFleetShipped } from '../fleet/shipped.js';
import { readHourShipped } from '../fleet/shipped-hour.js';
import { sendJson } from '../web/api.js';
import { packageRoot, readInstalledChangelog, WHATS_NEW_VERSION } from './changelog-read.js';
import { buildShipped, gitShippedSource, type ShippedReport, type ShippedSource } from '../release/shipped.js';

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

export const VERSE_SHIPPED_PATH = '/api/verse/shipped';
const SHIPPED_CACHE_MS = 5 * 60_000;
let shippedCache: { at: number; days: number; report: ShippedReport } | null = null;

/** Reads Phantom's own checkout. An installed copy has no git history, so its report says the source is unknown. */
export async function handleShippedApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: { source?: ShippedSource; now?: () => number; fleet?: typeof readFleetShipped; hour?: typeof readHourShipped } = {},
): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  const params = new URL(req.url ?? VERSE_SHIPPED_PATH, 'http://localhost').searchParams;
  if (params.has('since')) {
    const since = params.get('since');
    if ((since !== '24h' && since !== '1h') || [...params.keys()].some(key => key !== 'since')) {
      sendJson(res, 400, { error: 'use since=24h or since=1h for the fleet feed' }); return true;
    }
    if (since === '1h') { sendJson(res, 200, await (deps.hour ?? readHourShipped)({ now: (deps.now ?? Date.now)() })); return true; }
    sendJson(res, 200, await (deps.fleet ?? readFleetShipped)({ now: (deps.now ?? Date.now)() }));
    return true;
  }
  let raw: string | null = null;
  try { raw = new URL(req.url ?? VERSE_SHIPPED_PATH, 'http://localhost').searchParams.get('days'); } catch { /* 400 below */ }
  const days = raw === null ? 7 : /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 1 && days <= 90)) { sendJson(res, 400, { error: 'days must be a whole number from 1 to 90' }); return true; }
  const now = (deps.now ?? Date.now)();
  if (deps.source || !shippedCache || shippedCache.days !== days || now - shippedCache.at > SHIPPED_CACHE_MS) {
    const root = packageRoot();
    const source = deps.source ?? (root === null ? null : gitShippedSource(root));
    const read = source ? await source(now - days * 86_400_000) : { state: 'unknown' as const, note: 'No git history could be read here.', changes: [] };
    shippedCache = { at: now, days, report: buildShipped(read, { now, days }) };
  }
  sendJson(res, 200, shippedCache.report);
  return true;
}
