import { readFleetRunsDirState } from './runs-dir-state.js';
import { readFleetQueue } from './runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** A value-blind snapshot of dispatcher observations, not a reservation. */
export async function fleetStatusApi(runsDir?: string, now: () => number = Date.now) {
  const at = now();
  const [runs, queue] = await Promise.all([
    readFleetRunsDirState({ runsDir, now: () => at }),
    readFleetQueue({ runsDir, now: () => at }),
  ]);
  const fresh = runs.sources.status === 'healthy' && runs.lastTick !== null
    && at - Date.parse(runs.lastTick) >= 0 && at - Date.parse(runs.lastTick) <= 60_000;
  const safe = (s: string) => scrubSecrets(s) === s;
  return {
    schema: 'fleet.status-api.v1' as const,
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
      lane: l.lane, running: l.running, target: l.target, held: l.held,
      available: fresh && runs.paused === false ? (l.held ? 0 : Math.max(0, l.target - l.running)) : null,
      merged24h: l.merged24h,
    })),
    lanesTruncated: runs.lanes.length > 200,
    publishedLastHour: runs.sources.metrics === 'healthy' && runs.publishesLastHour.length < 50 ? runs.publishesLastHour.length : null,
  };
}
