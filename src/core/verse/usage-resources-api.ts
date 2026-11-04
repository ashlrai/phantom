/**
 * usage-resources-api.ts — GET /api/verse/usage-resources (RQ-NIGHT-USAGE-1).
 *
 * The one aggregate behind the Verse "Every resource" panel: twelve fixed
 * resources, each carrying its own reader's used / limit / resets-at /
 * source / as-of, or an explicit 'no-reader' state — never a fabricated
 * number. Read-only, behind the same read-session boundary as every other
 * /api/verse GET.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readUsageResources, type UsageResourcesSnapshot } from '../usage/resource-usage.js';
import { sendJson } from '../web/api.js';
import { resolveAccountsRoot } from './seats.js';
import type { VerseApiContext } from './verse-api.js';

export const USAGE_RESOURCES_PATH = '/api/verse/usage-resources';

export type UsageResourcesRead = (ctx: VerseApiContext) => Promise<UsageResourcesSnapshot>;

let readForTest: UsageResourcesRead | null = null;

/** Test seam: swap the aggregate read; null restores the real one. */
export function setUsageResourcesReadForTest(read: UsageResourcesRead | null): void {
  readForTest = read;
}

function realRead(ctx: VerseApiContext): Promise<UsageResourcesSnapshot> {
  return readUsageResources({ accountsRoot: resolveAccountsRoot(ctx.cfg) });
}

export async function handleUsageResourcesApi(
  ctx: VerseApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<boolean> {
  if (path !== USAGE_RESOURCES_PATH) return false;
  if (method !== 'GET') { sendJson(res, 404, { error: 'Usage resources are read only.' }); return true; }
  try {
    const url = new URL(req.url ?? path, 'http://localhost');
    if (url.search) { sendJson(res, 400, { error: 'Usage resources do not accept query parameters.' }); return true; }
  } catch { sendJson(res, 400, { error: 'Invalid query string.' }); return true; }
  sendJson(res, 200, await (readForTest ?? realRead)(ctx));
  return true;
}
