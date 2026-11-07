import { join } from 'node:path';
import { getFleetLaneSnapshot } from './lane-console.js';
import { readFleetQueue } from './runs-parked-queue.js';

export interface LaneQueueCountsRow {
  lane: string;
  /** READY rows queued for the lane; null when ready.tsv was unreadable. */
  ready: number | null;
  /** PARKED-* rows (waiting on a dependency or hold); null when ready.tsv was unreadable. */
  parked: number | null;
  /** Jobs occupying a lane slot now; null when no live source exists. */
  running: number | null;
  /** Unique merged PRs/jobs in the trailing hour; null when no merge ledger exists. */
  merges: number | null;
}

export interface LaneQueueCountsReport {
  schema: 'fleet.queue-counts.v1';
  generatedAt: string;
  windowMinutes: 60;
  totals: { ready: number; parked: number; running: number; merges: number };
  lanes: LaneQueueCountsRow[];
}

const sum = (rows: readonly LaneQueueCountsRow[], key: 'ready' | 'parked' | 'running' | 'merges'): number =>
  rows.reduce((total, row) => total + (row[key] ?? 0), 0);

/**
 * Per-lane ready / parked / running counts plus actual merges in the trailing
 * hour. Composes the existing readers so every count keeps their rules:
 * rows without a pool are dropped, rows without a usable timestamp never count
 * as merges, and duplicate merge events fold by PR, then job. Read-only.
 */
export async function getLaneQueueCounts(
  opts: { runsDir: string; now?: () => Date },
): Promise<LaneQueueCountsReport> {
  const now = opts.now ?? (() => new Date());
  const queueDir = join(opts.runsDir, 'queue');
  const [queue, snapshot] = await Promise.all([
    readFleetQueue({ runsDir: opts.runsDir, now: () => now().getTime() }),
    getFleetLaneSnapshot({
      queueDir, now, mergeWindowMs: 3_600_000, usageLogPaths: [], budgetsDir: join(queueDir, 'budgets'),
    }),
  ]);
  const byLane = new Map(queue.byLane.map(row => [row.lane, row]));
  const readyKnown = queue.sources.ready !== 'missing';
  // Budget- and hold-only lanes carry no queue activity; leave them out.
  const lanes = new Set([
    ...byLane.keys(),
    ...snapshot.lanes.filter(v => (v.liveJobs ?? 0) > 0 || (v.mergesPerHour ?? 0) > 0).map(v => v.lane),
  ]);
  const rows: LaneQueueCountsRow[] = [...lanes].map(lane => {
    const view = snapshot.lanes.find(v => v.lane === lane);
    const counts = byLane.get(lane);
    return {
      lane,
      ready: readyKnown ? counts?.ready ?? 0 : null,
      parked: readyKnown ? counts?.parked ?? 0 : null,
      running: view?.liveJobs ?? null,
      // Window is exactly one hour, so the per-hour rate is the count.
      merges: view?.mergesPerHour ?? null,
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
  return {
    schema: 'fleet.queue-counts.v1',
    generatedAt: now().toISOString(),
    windowMinutes: 60,
    totals: { ready: sum(rows, 'ready'), parked: sum(rows, 'parked'), running: sum(rows, 'running'), merges: sum(rows, 'merges') },
    lanes: rows,
  };
}
