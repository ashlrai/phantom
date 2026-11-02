import { lanes } from './drop-job-model.js';
import type { PreflightTargets } from './drop-job-preflight.js';

type Row = PreflightTargets['lanes'][number];

function knownRunning(row: Row): number | null {
  return typeof row.running === 'number' && Number.isFinite(row.running) && row.running >= 0 ? row.running : null;
}

function isBlocked(row: Row): boolean {
  const running = knownRunning(row);
  return row.held || row.target === 0 || (running !== null && running >= row.target);
}

/** The unheld lane, other than `current`, with the most free slots — offered only when `current` cannot start a job now. */
export function freeLaneAlternative(
  current: string,
  targets: PreflightTargets | null | undefined,
): { lane: string; freeSlots: number } | null {
  if (!targets || targets.sourceState !== 'healthy') return null;
  const own = targets.lanes.find(row => row.lane === current);
  if (!own || !isBlocked(own)) return null;
  let best: { lane: string; freeSlots: number } | null = null;
  for (const row of targets.lanes) {
    if (row.lane === current || row.held || !lanes.some(lane => lane === row.lane)) continue;
    const running = knownRunning(row);
    if (running === null) continue;
    const free = row.target - running;
    if (free <= 0) continue;
    if (!best || free > best.freeSlots || (free === best.freeSlots && row.lane < best.lane)) best = { lane: row.lane, freeSlots: free };
  }
  return best;
}
