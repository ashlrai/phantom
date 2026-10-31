import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';

export const TYPICAL_RUN_SECONDS = 15 * 60;
export const HORIZON_SECONDS = 15 * 60;

type Lane = FleetRunsV1['lanes'][number];
export interface LaneSupply extends Pick<Lane, 'lane' | 'running' | 'target' | 'held' | 'heldReason' | 'queued'> {
  freeNow: number;
  freeingSoon: number;
  pendingFiles: number;
  demand: number;
  shortfall: number;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** Uses snapshot ages directly; wall-clock time does not change a sampled worker age. */
export function laneSupply(snapshot: unknown, _now?: number): LaneSupply[] {
  const data = asRecord(snapshot);
  if (!Array.isArray(data.lanes)) return [];
  const workers = Array.isArray(data.workers) ? data.workers.map(asRecord) : [];
  const pending = asRecord(data.drop).pending;
  const files = Array.isArray(pending) ? pending.map(asRecord) : [];
  return data.lanes.flatMap(value => {
    const lane = asRecord(value);
    if (typeof lane.lane !== 'string' || !lane.lane.trim()) return [];
    const running = count(lane.running);
    const target = count(lane.target);
    const queued = count(lane.queued);
    const held = lane.held === true;
    const freeNow = Math.max(target - running, 0);
    const freeingSoon = workers.filter(worker => worker.lane === lane.lane && typeof worker.ageSeconds === 'number'
      && Number.isFinite(worker.ageSeconds) && worker.ageSeconds >= TYPICAL_RUN_SECONDS - HORIZON_SECONDS).length;
    const pendingFiles = files.filter(file => file.lane === lane.lane).length;
    const demand = freeNow + freeingSoon;
    return [{ lane: lane.lane, running, target, queued, held,
      heldReason: typeof lane.heldReason === 'string' ? lane.heldReason : null,
      freeNow, freeingSoon, pendingFiles, demand, shortfall: held ? 0 : Math.max(demand - pendingFiles - queued, 0) }];
  }).sort((a, b) => b.shortfall - a.shortfall || a.lane.localeCompare(b.lane));
}

export function totalShortfall(rows: readonly LaneSupply[]): number {
  return rows.reduce((sum, row) => sum + row.shortfall, 0);
}

export function supplyHeadline(rows: readonly LaneSupply[]): string {
  if (rows.length > 0 && rows.every(row => row.held)) return 'All lanes held';
  const total = totalShortfall(rows);
  return total > 0 ? `Write ${total} more job files` : 'Lanes are supplied';
}
