import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { buildFleetLiveSnapshot } from './fleet-live-api.js';
import { getFleetSessions, type FleetSessionsV1 } from '../fleet/runs-sessions.js';
import { readFleetEdges, type FleetEdges } from '../fleet/fleet-edges.js';
import { getLaneModelSnapshot, type LaneModelSnapshot } from '../fleet/lane-models.js';
import { fleetOrgMap, mapWindowMinutes, type FleetOrgMap } from '../fleet/org-map.js';
import { fleetOrgTree, type FleetOrgTree } from '../fleet/org-tree.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../fleet/runs-resource-ledger.js';
import type { LaneHealth } from '../fleet/lane-badge.js';
import { buildLeaderSeat } from '../fleet/leader-seat.js';
import { readPortableFleetLanes, type PortableFleetLane } from '../fleet/portable-lanes.js';
import { loadVerifiedRegistry, type VerifiedModelRegistryEntry } from '../fleet/model-verify.js';

/** Every source the org reads. Tests pass fixtures; each reader may fail alone and its facts then read unknown. */
export interface FleetOrgReaders {
  registry: () => Promise<VerifiedModelRegistryEntry[]>;
  live: () => Promise<Pick<Awaited<ReturnType<typeof buildFleetLiveSnapshot>>, 'snapshot'>>;
  sessions: (clock: { now: () => number }) => Promise<FleetSessionsV1>;
  runs: (clock: { now: () => number }) => Promise<FleetRunsDirState>;
  ledger: (clock: { now: () => number }) => Promise<ResourceLedgerV1>;
  models: () => Promise<LaneModelSnapshot>;
  /** Lane health badges; may fail alone, then every lane's health reads null. */
  laneHealth: () => Promise<{ lanes: readonly { lane: string; health?: LaneHealth | null }[] }>;
  messages: (options: { now: () => number; windowMinutes: number }) => FleetEdges | null;
  profileLanes: () => Promise<PortableFleetLane[]>;
  now: () => number;
}
export const fleetOrgReaders: FleetOrgReaders = { live: buildFleetLiveSnapshot, sessions: getFleetSessions, runs: readFleetRunsDirState,
  registry: loadVerifiedRegistry, profileLanes: readPortableFleetLanes,
  ledger: readResourceLedger, models: () => getLaneModelSnapshot(),
  laneHealth: async () => {
    const { getFleetLaneSnapshot } = await import('../fleet/lane-console.js');
    const { fleetLaneEmptyNotes } = await import('../fleet/lane-empty-notes.js');
    return getFleetLaneSnapshot({ emptyNotes: fleetLaneEmptyNotes });
  }, messages: readFleetEdges, now: Date.now };

/** The org map, its tree and the pool-usage ledger it was built from (`phm map` also draws the ledger's resources). */
export async function readFleetOrgSources(minutes = 60, readers: Partial<FleetOrgReaders> = {}): Promise<{ map: FleetOrgMap & { tree: FleetOrgTree }; usage: ResourceLedgerV1 | null }> {
  mapWindowMinutes(String(minutes));
  const read = { ...fleetOrgReaders, ...readers }, now = read.now(), clock = { now: () => now };
  const settled = <T>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null;
  const [live, sessions, runs, ledger, models, registry, health, profileLanes] = await Promise.allSettled([read.live(), read.sessions(clock), read.runs(clock), read.ledger(clock), read.models(), read.registry(), read.laneHealth(), read.profileLanes()]);
  let messages: FleetEdges | null = null;
  try { messages = read.messages({ ...clock, windowMinutes: minutes }); } catch { /* messages then read unknown */ }
  const snapshot = settled(live)?.snapshot ?? null, usage = settled(ledger), runState = settled(runs);
  const map = fleetOrgMap(snapshot, { sessions: settled(sessions), messages, minutes, now, profileLanes: settled(profileLanes) ?? [],
    observedLanes: runState?.lanes.map(lane => lane.lane) });
  const leaderSeat = buildLeaderSeat(settled(runs), settled(models), settled(registry), now);
  return { map: { ...map, tree: fleetOrgTree(map, { runs: runState, usage, engineLanes: snapshot?.lanes, models: settled(models), leaderSeat, laneHealth: settled(health)?.lanes }) }, usage };
}
export async function readFleetOrgMap(minutes = 60, readers: Partial<FleetOrgReaders> = {}): Promise<FleetOrgMap & { tree: FleetOrgTree }> {
  return (await readFleetOrgSources(minutes, readers)).map;
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
