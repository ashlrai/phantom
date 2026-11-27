/** Pure measured-capacity projection shared by pool dispatch and fleet views. No authority or IO. */
import { NODE_HEARTBEAT_MS, type NodesState } from '../drive/nodes/state.js';
import { nodeCapacityView } from '../drive/nodes/router.js';
import { dispatcherAdmissionHeadroom, laneLaunchTarget } from './lane-launch-target.js';
import { scrubSecrets } from '../util/scrub.js';

const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const fresh = (at: number, now: number, interval: number) => at > 0 && at <= now && now - at <= 2 * interval;
const safe = (s: string) => scrubSecrets(s) === s;

export function projectFleetAwareness(state: NodesState | null, now: number, dispatcher?: unknown) {
  const hosts = nodeCapacityView(state, now);
  const d = obj(dispatcher), at = typeof d.last_tick === 'string' ? Date.parse(d.last_tick) : NaN;
  // Dispatchd ticks every 30 seconds; old targets are never reported as free capacity.
  const dispatcherFresh = fresh(at, now, 30_000);
  const unpaused = d.paused === false || (d.schema === 'dispatchd.status.v1' && d.paused === null);
  const headroom = dispatcherAdmissionHeadroom(d.admission, d.last_tick);
  const stopped = d.paused === true || (typeof d.paused === 'string' && d.paused.trim().length > 0) || headroom === 0;
  const lanes = Object.entries(obj(d.lanes)).slice(0, 128).filter(([id]) => /^[a-z][a-z0-9-]{1,30}$/.test(id) && safe(id)).map(([lane, value]) => {
    const row = obj(value), running = dispatcherFresh ? count(row.running) : null, target = count(row.target),
      effectiveTarget = count(row.effective_target);
    let available: number | null = null;
    if (dispatcherFresh && (stopped || row.held === true)) available = 0;
    else if (unpaused && row.held === false && running !== null && target !== null) {
      available = Math.min(headroom ?? Infinity, Math.max(0, laneLaunchTarget(target, effectiveTarget) - running));
    }
    return { lane, running, target, effectiveTarget, floor: count(row.floor), queued: dispatcherFresh ? count(row.queued) : null,
      available };
  });
  return { schema: 'fleet.awareness.v1' as const, generatedAt: new Date(now).toISOString(), heartbeatMs: NODE_HEARTBEAT_MS,
    hosts, lanes, queue: { nodePending: state ? state.jobs.filter(j => j.state === 'pending' ||
      (j.state === 'running' && j.claim && j.claim.expiresAt <= now)).length : null,
    laneQueued: dispatcherFresh && lanes.length && lanes.every(l => l.queued !== null) ? lanes.reduce((n, l) => n + l.queued!, 0) : null } };
}
