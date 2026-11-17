import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveSnapshot } from './fleet-live-api.js';
import { getFleetSessions } from '../fleet/runs-sessions.js';
import { readFleetEdges } from '../fleet/fleet-edges.js';
import { fleetOrgMap, mapWindowMinutes, type FleetOrgMap } from '../fleet/org-map.js';
import { fleetOrgTree, type FleetOrgTree } from '../fleet/org-tree.js';
import { readFleetRunsDirState } from '../fleet/runs-dir-state.js';
import { readResourceLedger } from '../fleet/runs-resource-ledger.js';

export async function readFleetOrgMap(minutes = 60): Promise<FleetOrgMap & { tree: FleetOrgTree }> {
  mapWindowMinutes(String(minutes));
  const now = Date.now(), clock = { now: () => now };
  const settled = <T>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null;
  const [live, sessions, runs, usage] = await Promise.allSettled([buildFleetLiveSnapshot(), getFleetSessions(clock), readFleetRunsDirState(clock), readResourceLedger(clock)]);
  const messages = readFleetEdges({ ...clock, windowMinutes: minutes });
  const snapshot = settled(live)?.snapshot ?? null;
  const map = fleetOrgMap(snapshot, { sessions: settled(sessions), messages, minutes, now });
  return { ...map, tree: fleetOrgTree(map, { runs: settled(runs), usage: settled(usage), engineLanes: snapshot?.lanes }) };
}
export function createFleetOrgMapApi(read = readFleetOrgMap): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (path !== '/api/verse/fleet/control/map') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
      sendJson(res, 401, { error: 'A current read session is required.' }); return true;
    }
    let minutes: number;
    try {
      const params = new URL(req.url ?? path, 'http://localhost').searchParams;
      if ([...params.keys()].some(key => key !== 'minutes') || params.getAll('minutes').length > 1) throw new Error('Invalid query');
      minutes = mapWindowMinutes(params.get('minutes') ?? undefined);
    } catch { sendJson(res, 400, { error: 'Use minutes=1..1440 only.' }); return true; }
    try { sendJson(res, 200, await read(minutes)); }
    catch { sendJson(res, 503, { error: 'Fleet map unavailable.' }); }
    return true;
  };
}
export const handleFleetOrgMapApi = createFleetOrgMapApi();
