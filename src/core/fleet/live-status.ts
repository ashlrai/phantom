import type { FleetLiveSnapshotV1 } from './fleet-types.js';
import type { ResourceView } from '../fabric/resource-view.js';

/** Shared CLI/home projection. Unknown source readings stay unknown. */
export function projectLiveStatus(live: FleetLiveSnapshotV1, resources: ResourceView) {
  return {
    v: 1 as const, generatedAt: live.generatedAt, state: live.state, reason: live.stateReason,
    running: live.summary.building === null ? null : live.runs.filter(run =>
      run.endedAt === null && ['producing', 'verifying', 'judging', 'landing'].includes(run.phase)),
    merged: live.merged24h ?? null,
    blocked: live.blockedHolds === undefined || live.blockedHolds === null ? null : [
      ...live.blockedHolds,
      ...live.runs.filter(run => run.phase === 'parked').map(run => ({ repo: run.repo, reason: run.hold?.reason ?? run.title, until: run.hold?.nextEligibleAt ?? null })),
    ],
    spent: resources.pools.map(pool => ({ pool: pool.pool, pctUsed: pool.pctUsed, resetAt: pool.resetAt })),
  };
}
