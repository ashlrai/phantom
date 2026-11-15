/**
 * Read-only hourly merge graph: merges and median open-to-merge time per lane, last 24 hours.
 *   GET /api/verse/fleet/control/merge-graph -> MergeGraphReport (metrics.merges.v1)
 * Served through the fleet-control family (fleet-control-api.ts), like disk-runway, so it needs no
 * entry in the frozen A10 mount table and stays out of the merge-pace module, which is Tier-1 closure.
 * Same jobs ledger reader as `ashlr fleet merge-pace` and `fleet task-check`.
 */
import { readTaskCheckJobs } from '../../cli/fleet-task-check.js';
import { mergeGraph } from '../fleet/merge-graph.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_MERGE_GRAPH_PATH = '/api/verse/fleet/control/merge-graph';

export interface FleetMergeGraphApiDeps {
  /** Raw jobs.jsonl text, or null when unreadable; injected in tests. */
  read?: () => Promise<string | null>;
  now?: () => number;
}

export function createFleetMergeGraphApi(deps: FleetMergeGraphApiDeps = {}): ApiModule {
  const read = deps.read ?? readTaskCheckJobs;
  const now = deps.now ?? Date.now;
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_MERGE_GRAPH_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    // A reader failure is unknown (known:false), never a 500 or an empty graph.
    let raw: string | null;
    try { raw = await read(); } catch { raw = null; }
    sendJson(res, 200, mergeGraph(raw, now()));
    return true;
  };
}

export const handleFleetMergeGraphApi: ApiModule = createFleetMergeGraphApi();
