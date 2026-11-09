import { join } from 'node:path';
import { getFleetLaneSnapshot } from './lane-console.js';
import { readFleetQueue, readSource } from './runs-parked-queue.js';

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
  /** Oldest ready or parked job's wait in seconds; null if any wait is unknown. */
  oldestWaitSeconds: number | null;
}

export interface LaneQueueCountsReport {
  schema: 'fleet.queue-counts.v1';
  generatedAt: string;
  windowMinutes: 60;
  totals: { ready: number | null; parked: number | null; running: number | null; merges: number | null };
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
  const at = now();
  const waiting = new Map<string, string[]>();
  const [queue, snapshot, metrics] = await Promise.all([
    readFleetQueue({ runsDir: opts.runsDir, now: () => at.getTime(), onWaitingJob: (lane, id) => {
      const jobs = waiting.get(lane) ?? []; jobs.push(id); waiting.set(lane, jobs);
    } }),
    getFleetLaneSnapshot({
      queueDir, now: () => at, mergeWindowMs: 3_600_000, usageLogPaths: [], budgetsDir: join(queueDir, 'budgets'),
    }),
    readSource(join(opts.runsDir, 'metrics', 'jobs.jsonl'), 2 * 1024 * 1024, false),
  ]);
  const queued = new Map<string, Set<number>>();
  for (const line of metrics.text.split('\n')) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (!row || typeof row !== 'object' || (row.event ?? row.type) !== 'queued') continue;
      const id = row.job ?? row.job_id ?? row.jobId;
      const raw = row.ts ?? row.timestamp ?? row.at;
      const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (typeof id !== 'string' || !Number.isFinite(time) || time > at.getTime()) continue;
      const times = queued.get(id) ?? new Set<number>(); times.add(time); queued.set(id, times);
    } catch { /* Ignore malformed metrics rows. */ }
  }
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
    const jobs = waiting.get(lane) ?? [];
    const times = jobs.map(id => queued.get(id));
    const oldestWaitSeconds = metrics.state === 'healthy' && queue.sources.ready === 'healthy' && jobs.length > 0 && times.every(t => t?.size === 1)
      ? Math.floor((at.getTime() - Math.min(...times.map(t => [...t!][0]!))) / 1000) : null;
    return {
      lane,
      ready: readyKnown ? counts?.ready ?? 0 : null,
      parked: readyKnown ? counts?.parked ?? 0 : null,
      running: view?.liveJobs ?? null,
      // Window is exactly one hour, so the per-hour rate is the count.
      merges: view?.mergesPerHour ?? null,
      oldestWaitSeconds,
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
  return {
    schema: 'fleet.queue-counts.v1',
    generatedAt: at.toISOString(),
    windowMinutes: 60,
    totals: {
      ready: readyKnown ? sum(rows, 'ready') : null,
      parked: readyKnown ? sum(rows, 'parked') : null,
      running: (snapshot.sources.queueState.state === 'healthy' || snapshot.sources.queue.state === 'healthy') && rows.every(r => r.running !== null) ? sum(rows, 'running') : null,
      merges: snapshot.sources.ledger.state === 'healthy' && rows.every(r => r.merges !== null) ? sum(rows, 'merges') : null,
    },
    lanes: rows,
  };
}
