import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import { collectBusWorkItemEvidence, type BusWorkItemEvidenceResult } from '../comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../comms/work-item-state.js';

export const WORK_TRACE_MAX_IDS = 20;
export const WORK_TRACE_MAX_ID_LENGTH = 200;

type Collect = (id: string, options: { root: string; now: number }) => BusWorkItemEvidenceResult;

/** Same composition as `ashlr fleet work-trace`, batched. Read-only: state comes only from the
 * durable stores and is never upgraded here; labels grant no authority. */
export function createFleetWorkTraceApi(
  collect: Collect = collectBusWorkItemEvidence,
  clock: () => number = Date.now,
  rootOf: () => string = () => join(ashlrHome(), 'fleet'),
): ApiModule {
  return async (_ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/work-trace') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const params = new URL(req.url ?? path, 'http://localhost').searchParams;
    const ids = params.getAll('id');
    if ([...params.keys()].some(key => key !== 'id') || ids.length < 1 || ids.length > WORK_TRACE_MAX_IDS
      || ids.some(id => !id.trim() || id.length > WORK_TRACE_MAX_ID_LENGTH || id.includes('\0'))) {
      sendJson(res, 400, { error: 'invalid query parameters' }); return true;
    }
    const now = clock();
    const nowIso = new Date(now).toISOString();
    const items = ids.map(id => {
      try {
        const { evidence, sources } = collect(id, { root: rootOf(), now });
        return { id, ...classifyWorkItem(evidence, nowIso), owner: evidence.owner ?? null,
          claimReceipt: evidence.claimReceipt ?? null, inbox: sources.inbox, claims: sources.claims };
      } catch {
        // Never send the thrown message; same shape as the CLI's unknown id.
        return { id, state: 'RECEIVED' as const, asOf: 'unknown', source: 'none', missing: ['work-item evidence'],
          owner: null, claimReceipt: null, inbox: 'unavailable' as const, claims: 'unavailable' as const };
      }
    });
    sendJson(res, 200, { v: 1, authority: 'none', generatedAt: nowIso, items });
    return true;
  };
}
export const handleFleetWorkTraceApi = createFleetWorkTraceApi();
