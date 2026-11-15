/**
 * GET /api/verse/growth?range=1H|1D|1W|1M
 * The desktop Growth charts read the same series as `phm growth --json`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readGrowthReport } from '../growth/read.js';
import { isGrowthRange } from '../growth/series.js';
import { sendJson } from '../web/api.js';

export const GROWTH_PATH = '/api/verse/growth';

export function isGrowthPath(path: string): boolean {
  return path === GROWTH_PATH;
}

function rangeOf(req: IncomingMessage): string | null {
  const raw = req.url ?? '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  return new URLSearchParams(query).get('range') ?? '1D';
}

export async function handleGrowthApi(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> {
  if (!isGrowthPath(path)) return false;
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const range = rangeOf(req);
  if (!range || !isGrowthRange(range)) {
    sendJson(res, 400, { error: 'range must be 1H, 1D, 1W, or 1M' });
    return true;
  }
  const report = await readGrowthReport({ range });
  if (!report) {
    sendJson(res, 500, { error: 'growth series could not be read' });
    return true;
  }
  sendJson(res, 200, report);
  return true;
}
