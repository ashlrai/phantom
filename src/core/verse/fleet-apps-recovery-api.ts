/** Retained recovery evidence only: no probes or app control. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppsRecoveryInvocations } from '../fleet/apps-recovery-invocations.js';
import { appsRecoveryVerdict } from '../fleet/apps-recovery-verdict.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { handleFleetAppsApi } from './fleet-apps-api.js';

export const handleFleetAppsRecoveryApi: ApiModule = async (ctx, req, res, path, method) => {
  if (path !== '/api/verse/fleet/apps/recovery') return handleFleetAppsApi(ctx, req, res, path, method);
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  const apps = new Map<string, { app: string; at: number; outcome: string }>();
  try {
    const projection = readAppsRecoveryInvocations(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
    if (projection.availability === 'available') for (const row of projection.invocations) {
      const verdict = appsRecoveryVerdict(projection, row.invocationId, 30 * 60_000, Date.now());
      for (const state of row.retainedObservedState ?? []) {
        if (apps.has(state.app)) continue;
        const outcome = state.observedRunning === true ? 'recovered'
          : row.terminalOutcome === 'failed' ? 'gave-up'
          : row.terminalOutcome === 'cancelled' ? 'cancelled'
          : verdict.verdict === 'stale' ? 'stale'
          : state.observedRunning === false ? 'failed' : 'unknown';
        apps.set(state.app, { app: state.app, at: row.latestTime, outcome });
      }
    }
  } catch { /* unreadable history is an empty reading */ }
  sendJson(res, 200, { v: 1, apps: [...apps.values()] });
  return true;
};
