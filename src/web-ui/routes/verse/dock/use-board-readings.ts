/**
 * routes/verse/dock/use-board-readings.ts — the reads behind the words the switcher shows beside each board's
 * name. Every board is read through the query its own pane uses, so the cache entry is shared and the row never
 * asks for something the board would not:
 *
 *   Pools     GET /api/app/pools                      (`phm pools`)
 *   Usage     GET /api/verse/accounts                 (counted as `phm usage limits` counts them)
 *   Router    GET /api/verse/budget/preview           (one unlogged preview per task and difficulty, fleet work)
 *   Models    GET /api/verse/fleet/control/models and /check   (`phm models`, `phm models check`)
 *   Lanes     GET /api/verse/fleet/runs               (`phm fleet runs`)
 *   Capacity  GET /api/verse/runs-history?hours=24    (the board's default window)
 *   Supply    GET /api/verse/fleet/runs               (the same snapshot Lanes reads)
 *
 * A read is only made while the row is on screen and lists that board. A read that has not answered, last failed,
 * or holds a body this row cannot vouch for gives no reading: a failed refresh keeps the old data in the cache, and
 * a count from it must not read as current.
 */
import type { RunsHistory } from '../../../../core/fleet/runs-history.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { runsHistoryQuery } from '../fleet-capacity/capacity-queries.js';
import { fleetPoolsQuery } from '../fleet-pools/pools-query.js';
import { routerRoutesQuery } from '../fleet-router/router-model.js';
import { rowsFromAccounts } from '../fleet-usage/usage-pane-model.js';
import { modelCheckQuery, modelRegistryQuery } from '../models/models-queries.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import {
  capacityReading, lanesReading, modelsReading, poolsReading, routerReading, supplyReading, usageReading, type BoardReading,
} from './resource-board-readings.js';

/** Long enough that a recent read by the board itself, or by Home, is reused instead of asked for again. */
const READING_POLL_MS = 30_000;
/**
 * The slower reads: accounts ask the providers (the Usage board's own interval), the route table is fifteen
 * previews, the model check and the day of capacity samples change slowly.
 */
const SLOW_POLL_MS = 60_000;

/** One stable definition each, so the row and the boards share a cache entry: fleet work, and the board's default day. */
const FLEET_ROUTES = routerRoutesQuery(true);
const DAY_HISTORY = runsHistoryQuery(24);

/** A reading is only taken from a read that last succeeded. */
const settled = <T,>(read: { status: string; data: T | undefined }): T | undefined => read.status === 'error' ? undefined : read.data;

/** The readings to draw, by board id. */
export function useBoardReadings(ids: readonly string[], on: boolean): ReadonlyMap<string, BoardReading> {
  const want = (id: string): boolean => on && ids.includes(id);
  const wantPools = want('fleet-pools'), wantUsage = want('fleet-usage'), wantRouter = want('fleet-router'), wantModels = want('models');
  const wantLanes = want('fleet-lanes'), wantCapacity = want('fleet-capacity'), wantSupply = want('fleet-supply');
  const wantRuns = wantLanes || wantSupply;

  const pools = useQuery(fleetPoolsQuery, { enabled: wantPools, freshMs: READING_POLL_MS });
  const runs = useQuery(opsRunsQuery, { enabled: wantRuns, freshMs: READING_POLL_MS });
  const accounts = useQuery(verseAccountsQuery, { enabled: wantUsage, freshMs: SLOW_POLL_MS });
  const routes = useQuery(FLEET_ROUTES, { enabled: wantRouter, freshMs: SLOW_POLL_MS });
  const registry = useQuery(modelRegistryQuery, { enabled: wantModels, freshMs: SLOW_POLL_MS });
  const check = useQuery(modelCheckQuery, { enabled: wantModels, freshMs: SLOW_POLL_MS });
  const history = useQuery(DAY_HISTORY, { enabled: wantCapacity, freshMs: SLOW_POLL_MS });
  usePollWhileVisible(useRefetch(fleetPoolsQuery), READING_POLL_MS, { enabled: wantPools, refreshOnShow: false });
  usePollWhileVisible(useRefetch(opsRunsQuery), READING_POLL_MS, { enabled: wantRuns, refreshOnShow: false });
  usePollWhileVisible(useRefetch(verseAccountsQuery), SLOW_POLL_MS, { enabled: wantUsage, refreshOnShow: false });
  usePollWhileVisible(useRefetch(FLEET_ROUTES), SLOW_POLL_MS, { enabled: wantRouter, refreshOnShow: false });
  const refetchRegistry = useRefetch(modelRegistryQuery), refetchCheck = useRefetch(modelCheckQuery);
  usePollWhileVisible(() => { refetchRegistry(); refetchCheck(); }, SLOW_POLL_MS, { enabled: wantModels, refreshOnShow: false });
  usePollWhileVisible(useRefetch(DAY_HISTORY), SLOW_POLL_MS, { enabled: wantCapacity, refreshOnShow: false });

  const out = new Map<string, BoardReading>();
  const put = (id: string, wanted: boolean, reading: BoardReading | null): void => { if (wanted && reading) out.set(id, reading); };

  // The cache entries are shared by key with other readers, so each shape is checked here too.
  const poolsNow = settled(pools);
  put('fleet-pools', wantPools, Array.isArray(poolsNow?.pools) ? poolsReading(poolsNow) : null);

  // An accounts read the server could not answer, or a body that is not the accounts snapshot, is no reading.
  const accountsNow = settled(accounts);
  const snapshot = accountsNow?.available === true ? projectAccountsSnapshot(accountsNow.raw) : null;
  put('fleet-usage', wantUsage, snapshot === null ? null : usageReading(rowsFromAccounts(snapshot)));

  const routesNow = settled(routes);
  put('fleet-router', wantRouter, Array.isArray(routesNow?.routes) ? routerReading(routesNow) : null);

  // Either read alone still names models; a check that could not read its registry holds no verdicts.
  const checkNow = settled(check);
  put('models', wantModels, modelsReading({ registry: settled(registry)?.entries ?? null, check: checkNow?.registry === 'ok' ? checkNow : null }));

  const runsNow = settled(runs);
  const fleet = isFleetRuns(runsNow) ? runsNow : null;
  put('fleet-lanes', wantLanes, fleet && lanesReading(fleet));
  put('fleet-supply', wantSupply, fleet && supplyReading(fleet));

  const historyNow: RunsHistory | null | undefined = settled(history);
  put('fleet-capacity', wantCapacity, historyNow ? capacityReading(historyNow, Date.now()) : null);
  return out;
}
