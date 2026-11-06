/** Bounded, read-only projection of the planner acknowledgement ledger. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export interface FleetInboxAcksApiDeps { runsDir?: string; now?: () => number }
export function createFleetInboxAcksApi(deps: FleetInboxAcksApiDeps = {}): ApiModule {
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/inbox/acks' || method !== 'GET') return false;
    try {
      const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
      let available = true;
      let text = '';
      try {
        const file = await open(join(root, 'queue', 'inbox-acks.jsonl'), 'r');
        try {
          const { size } = await file.stat();
          const start = Math.max(0, size - 256 * 1024);
          const buffer = Buffer.alloc(size - start);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
          text = buffer.subarray(0, bytesRead).toString('utf8');
          // The bounded tail may start inside a row: never interpret that fragment.
          if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        available = false;
      }
      const rows = new Map<string, { entryId: string; status: 'acked' | 'skipped' }>();
      for (const line of text.split('\n')) {
        try {
          const row: unknown = JSON.parse(line);
          if (!row || typeof row !== 'object') continue;
          const { entryId, status } = row as Record<string, unknown>;
          if (typeof entryId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(entryId) || (status !== 'acked' && status !== 'skipped')) continue;
          rows.delete(entryId);
          rows.set(entryId, { entryId, status });
        } catch { /* Ignore malformed ledger rows. */ }
      }
      sendJson(res, 200, { v: 1, generatedAt: new Date((deps.now ?? Date.now)()).toISOString(), available, acks: [...rows.values()].slice(-500) });
    } catch { sendJson(res, 503, { error: 'inbox acks unavailable' }); }
    return true;
  };
}
export const handleFleetInboxAcksApi: ApiModule = createFleetInboxAcksApi();
