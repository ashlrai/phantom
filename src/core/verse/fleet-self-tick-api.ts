/**
 * Read-only self-tick last-run projection: queue/self-tick-last.json as the
 * desktop Needs-you list reads it. It never runs a tick and never takes the
 * self-tick lock — a GET only reads the record the timer's own write left.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSelfTickLast, type SelfTickLastView } from '../fleet/self-tick-last.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_SELF_TICK_PATH = '/api/verse/fleet/self-tick';
export interface FleetSelfTickResponseV1 {
  v: 1;
  last: SelfTickLastView | null;
}
export interface FleetSelfTickApiDeps {
  /** Runs root holding queue/self-tick-last.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention fleet-runs-api uses. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export function createFleetSelfTickApi(deps: FleetSelfTickApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_SELF_TICK_PATH || method !== 'GET') return false;
    try {
      // sendJson passes the body through sanitizePublicJson, the same
      // shared-read-surface rule the recorded file itself was written under.
      const body: FleetSelfTickResponseV1 = {
        v: 1,
        last: readSelfTickLast(deps.runsDir ?? defaultRunsDir(), now()),
      };
      sendJson(res, 200, body);
    } catch {
      // Fixed message: thrown errors can carry absolute paths or file text.
      sendJson(res, 503, { v: 1, error: 'fleet self-tick unavailable' });
    }
    return true;
  };
}
export const handleFleetSelfTickApi: ApiModule = createFleetSelfTickApi();
