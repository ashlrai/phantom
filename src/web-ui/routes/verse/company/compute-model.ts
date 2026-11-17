import type { HostStats } from '../../../../core/drive/nodes/state.js';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { isHostStats } from '../../../../core/drive/nodes/state.js';

export function isFleetCompute(value: unknown): value is FleetCompute {
  if (!value || typeof value !== 'object') return false;
  const v = value as FleetCompute;
  return v.schema === 'fleet.compute.v1' && typeof v.generatedAt === 'string' && typeof v.localNodeId === 'string' &&
    !!v.sources && typeof v.sources === 'object' && !!v.lanes && typeof v.lanes === 'object' &&
    Array.isArray(v.nodes) && v.nodes.every(n => n && typeof n.id === 'string' && typeof n.local === 'boolean' &&
      Array.isArray(n.jobs) && n.jobs.every(j => j && typeof j.job === 'string') && (n.stats === null || isHostStats(n.stats)));
}

export type CoreHistory = { previous: HostStats; samples: Array<Array<number | null>> };
/** Only counter deltas from ordered, recent samples establish utilization. Reboots reset the baseline. */
export function advanceCores(old: CoreHistory | undefined, next: HostStats, now: number): CoreHistory {
  if (old?.previous.sampledAtMs === next.sampledAtMs) return old;
  const elapsed = old ? next.sampledAtMs - old.previous.sampledAtMs : 0;
  const valid = !!old && elapsed > 0 && elapsed <= 90_000 && now >= next.sampledAtMs && now - next.sampledAtMs <= 90_000 &&
    next.uptimeSeconds >= old.previous.uptimeSeconds && old.previous.cores.length === next.cores.length;
  const values = next.cores.map((core, i) => {
    const prev = valid ? old.previous.cores[i] : undefined;
    const total = prev ? core.total - prev.total : 0, idle = prev ? core.idle - prev.idle : -1;
    return total > 0 && idle >= 0 && idle <= total ? (total - idle) / total * 100 : null;
  });
  return { previous: next, samples: [...(valid ? old.samples : []), values].slice(-32) };
}
export type { MapSession } from '../../../../core/fleet/sessions-view.js';

export function isFleetSessionMap(value: unknown): value is FleetSessionMap {
  if (!value || typeof value !== 'object') return false;
  const v = value as FleetSessionMap;
  const nullable = (s: unknown) => s === null || typeof s === 'string';
  const rows = (input: unknown) => Array.isArray(input) && input.every(s => s && typeof s.job === 'string' &&
    nullable(s.nodeId) && nullable(s.lane) && nullable(s.model) && nullable(s.activity) && nullable(s.branch) && nullable(s.prUrl) &&
    (s.worktree === null || s.worktree === 'recorded') &&
    ['claim', 'process', 'conflict', 'unknown'].includes(s.placement) &&
    ['running', 'idle', 'held', 'queued', 'unknown'].includes(s.mapState) &&
    ['queued', 'parked', 'launching', 'running', 'publishing', 'exited', 'stale', 'finished', 'unknown'].includes(s.status) &&
    (s.elapsedSeconds === null || (typeof s.elapsedSeconds === 'number' && Number.isFinite(s.elapsedSeconds) && s.elapsedSeconds >= 0)));
  return v.schema === 'fleet.sessions.v1' && typeof v.generatedAt === 'string' && typeof v.computeAt === 'string' &&
    ['healthy', 'missing', 'degraded'].includes(v.sourceState) && rows(v.mapSessions) && rows(v.mapRecent);
}

export const fresh = (at: number | null | undefined, now: number) => at != null && at <= now && now - at <= 90_000;
/** 1-minute load over the advisory 2 × CPU ceiling. Null (never zero) when no fresh reading exists. */
export function loadRatio(node: { stats: HostStats | null }, now: number): number | null {
  const s = node.stats;
  if (!s || !fresh(s.sampledAtMs, now) || !s.cores.length || s.load[0] == null) return null;
  return s.load[0] / (2 * s.cores.length);
}
