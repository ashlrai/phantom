/** GET /api/verse/fleet/disk-runway: read-only runway report; same builder as `phm disk runway` (fleet.disk-runway.v1). */
import { readDiskRunway, type DiskRunwayV1 } from '../fleet/disk-runway.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

/** The removal plan scans every worktree with git; a minute of reuse keeps a polling glance cheap. */
const CACHE_MS = 60_000;

export function createDiskRunwayApi(read: () => Promise<DiskRunwayV1> = readDiskRunway, now: () => number = Date.now): ApiModule {
  let cached: { at: number; body: DiskRunwayV1 } | null = null;
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/disk-runway') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: `method not allowed: ${method} ${path}` }); return true; }
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), body: await read() };
    sendJson(res, 200, cached.body);
    return true;
  };
}

export const handleDiskRunwayApi: ApiModule = createDiskRunwayApi();
