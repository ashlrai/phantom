/**
 * core/verse/fleet-merge-pace-api.ts — `GET /api/verse/fleet/merge-pace`
 * (mounted by verse-api.ts through the api-modules.ts contract).
 *
 * Serves exactly what `ashlr fleet merge-pace --json` prints
 * (core/fleet/merge-pace.ts, schema `fleet.merge-pace.v1`): merges, merges per
 * hour and median time to merge per repo over the last six hours, plus a
 * total row. Unreadable metrics answer 200 with `known: false` and
 * `rows: null` — unknown is never zero. Read-only; repo ids and numbers only.
 *
 *   GET /api/verse/fleet/merge-pace → MergePaceReport
 *   any other method on the path    → 405
 *   any other path                  → false (next module runs)
 */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { fleetMergePace, type MergePaceReport } from '../fleet/merge-pace.js';
import type { JobsMetricsReader } from '../fleet/jobs-metrics.js';

export const VERSE_FLEET_MERGE_PACE_PATH = '/api/verse/fleet/merge-pace';

export interface FleetMergePaceApiDeps {
  /** Reads the jobs ledger text; null when absent. Injected in tests. */
  read?: JobsMetricsReader;
  now?: () => number;
  /** Test seam for the whole report. */
  report?: (read: JobsMetricsReader | undefined, now: number) => Promise<MergePaceReport>;
}

export function createFleetMergePaceApi(deps: FleetMergePaceApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const build = deps.report ?? fleetMergePace;
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_MERGE_PACE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    sendJson(res, 200, await build(deps.read, now()));
    return true;
  };
}

export const handleFleetMergePaceApi: ApiModule = createFleetMergePaceApi();
