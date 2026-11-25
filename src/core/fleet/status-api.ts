import { readFleetAwareness } from './awareness-read.js';
import { laneLaunchTarget } from './lane-launch-target.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { readFleetQueue } from './runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';
import { readGuardianStatus } from './guardian-doctor.js';
import { readLeaderStatusSnapshot } from '../comms/leader-status-snapshot.js';
import { defaultRunsDir } from './landed-closes-read.js';

/** A value-blind snapshot of dispatcher observations, not a reservation. */
export async function fleetStatusApi(runsDir = defaultRunsDir(), now: () => number = Date.now) {
  const at = now();
  const [runs, queue, awareness, guardian, collected] = await Promise.all([
    readFleetRunsDirState({ runsDir, now: () => at }),
    readFleetQueue({ runsDir, now: () => at }),
    readFleetAwareness({ runsDir, now: at }),
    readGuardianStatus({ runsDir, now: () => at }),
    readLeaderStatusSnapshot({ runsDir, now: () => at }),
  ]);
  const fresh = runs.sources.status === 'healthy' && runs.lastTick !== null
    && at - Date.parse(runs.lastTick) >= 0 && at - Date.parse(runs.lastTick) <= 60_000;
  const safe = (s: string) => scrubSecrets(s) === s;
  // The public status contract carries measurements, not journal or table prose.
  const { ceo: _ceo, mains, ...observations } = collected;
  const { redRepos: _redRepos, ...mainHealth } = mains;
  const snapshot = { ...observations, mains: mainHealth,
    lanes: observations.lanes.filter(l => safe(l.lane)),
    laneActivity: observations.laneActivity.filter(l => safe(l.lane)),
  };
  return {
    schema: 'fleet.status-api.v1' as const, awareness, guardian, snapshot,
    generatedAt: new Date(at).toISOString(),
    sources: { status: runs.sources.status, claimed: runs.sources.claimed, queue: queue.sources.ready, metrics: runs.sources.metrics },
    observedAt: runs.lastTick,
    fresh,
    paused: runs.paused,
    sessions: runs.sources.claimed === 'missing' ? null : runs.claimed.filter(c => safe(c.job) && safe(c.lane) && safe(c.tier)).slice(0, 200)
      .map(c => ({ job: c.job, lane: c.lane, tier: c.tier, claimedAt: c.at })),
    sessionsTruncated: runs.claimed.length > 200,
    queue: queue.sources.ready === 'healthy' ? { ready: queue.ready, parked: queue.parked } : null,
    lanes: runs.lanes.filter(l => safe(l.lane)).slice(0, 200).map(l => ({
      lane: l.lane, running: fresh ? l.running : null, queued: fresh ? l.queued : null,
      target: l.target, effectiveTarget: l.effectiveTarget ?? null, held: l.held,
      available: fresh && runs.paused === false ? (l.held ? 0 : Math.max(0, laneLaunchTarget(l.target, l.effectiveTarget) - l.running)) : null,
      merged24h: fresh && Number.isSafeInteger(l.merged24h) ? l.merged24h : null,
    })),
    lanesTruncated: runs.lanes.length > 200,
    publishedLastHour: runs.sources.metrics === 'healthy' && runs.publishesLastHour.length < 50 ? runs.publishesLastHour.length : null,
  };
}

/** Shared JSON contract for `phm fleet status-api --json`. */
export type FleetStatusApi = Awaited<ReturnType<typeof fleetStatusApi>>;
