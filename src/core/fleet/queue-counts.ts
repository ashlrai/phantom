import { join } from 'node:path';
import { getFleetLaneSnapshot } from './lane-console.js';
import { readFleetQueue, readSourceEnds } from './runs-parked-queue.js';

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
  /** Why parked jobs are blocked, biggest group first (e.g. DEP, HOLD); empty when none or ready.tsv was unreadable. */
  blockedReasons: Array<{ reason: string; count: number }>;
  /** Parked dependency jobs whose gates all show MERGED but were never unparked; null when ready.tsv was unreadable. */
  stale: number | null;
}

export type QueueCountsSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';

export interface LaneQueueCountsReport {
  schema: 'fleet.queue-counts.v1';
  generatedAt: string;
  windowMinutes: 60;
  totals: {
    ready: number | null; parked: number | null; running: number | null; merges: number | null;
    blockedReasons: Array<{ reason: string; count: number }>; stale: number | null;
  };
  /** Health of each input, so a null count can be traced to the file that failed. */
  sources: { ready: QueueCountsSourceState; running: QueueCountsSourceState; ledger: QueueCountsSourceState };
  /** Plain-words reasons a count is unknown. Empty when every source is healthy. */
  notes: string[];
  lanes: LaneQueueCountsRow[];
}

const sum = (rows: readonly LaneQueueCountsRow[], key: 'running' | 'merges' | 'stale'): number =>
  rows.reduce((total, row) => total + (row[key] ?? 0), 0);

const rankReasons = (counts: ReadonlyMap<string, number>) => [...counts]
  .map(([reason, count]) => ({ reason, count }))
  .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

/** Per-end bound on the metrics ledger read; the two windows can overlap on smaller files. */
export const QUEUE_COUNTS_LEDGER_BYTES = 2 * 1024 * 1024;

/** Queue-arrival event spellings in metrics/jobs.jsonl — dispatchd writes `enqueue`; `queued` is the older alias. */
const ARRIVAL_EVENTS = new Set(['enqueue', 'queued']);
/** Queue departures: the job left ready.tsv to run — a solo claim or launch, or bundling into a batch session. */
const DEPARTURE_EVENTS = new Set(['claim', 'batch_claim', 'launch']);
/** task_outcome values that send a batch member back to ready.tsv (batcher.RETRY). */
const MEMBER_RETRY_OUTCOMES = new Set(['failed', 'deferred', 'unreported']);

/**
 * Per-lane ready / parked / running counts plus actual merges in the trailing
 * hour. Composes the existing readers so every count keeps their rules:
 * rows without a pool are dropped, rows without a usable timestamp never count
 * as merges, and duplicate merge events fold by PR, then job. Read-only.
 */
export async function getLaneQueueCounts(
  opts: { runsDir: string; now?: () => Date; ledgerBytes?: number },
): Promise<LaneQueueCountsReport> {
  const now = opts.now ?? (() => new Date());
  const queueDir = join(opts.runsDir, 'queue');
  const at = now();
  const waiting = new Map<string, string[]>();
  const [queue, snapshot, metrics] = await Promise.all([
    readFleetQueue({ runsDir: opts.runsDir, now: () => at.getTime(), depDetail: true, onWaitingJob: (lane, id) => {
      const jobs = waiting.get(lane) ?? []; jobs.push(id); waiting.set(lane, jobs);
    } }),
    getFleetLaneSnapshot({
      queueDir, now: () => at, mergeWindowMs: 3_600_000, usageLogPaths: [], budgetsDir: join(queueDir, 'budgets'),
    }),
    readSourceEnds(join(opts.runsDir, 'metrics', 'jobs.jsonl'), opts.ledgerBytes ?? QUEUE_COUNTS_LEDGER_BYTES),
  ]);
  // Queue marks per job in ledger order. dispatchd emits `enqueue` once per
  // job (its .enqueued receipt), so a re-queued job's current wait starts at
  // its latest re-arrival — a launch_failed retry, a retried task_outcome or
  // a fresh enqueue — not its first-ever enqueue. A departure clears the
  // arrival until the next entry; retry marks restart the dwell even when
  // the launch they follow sits in the ledger's unread middle. Silent
  // requeues (deferred launches, released batches, spawn failures) leave no
  // row, so a job whose last mark is a departure has unknown wait and the
  // lane reports null rather than a fabricated one.
  const marks = new Map<string, { at: number; entry: boolean; restart: boolean }[]>();
  for (const line of metrics.text.split('\n')) {
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const rawEvent = row.event ?? row.type ?? row.kind;
    const event = typeof rawEvent === 'string' ? rawEvent : null;
    const outcome = typeof row.outcome === 'string' ? row.outcome.toLowerCase() : null;
    let mark: { entry: boolean; restart: boolean } | null = null;
    if (event !== null && ARRIVAL_EVENTS.has(event)) mark = { entry: true, restart: false };
    else if (event !== null && DEPARTURE_EVENTS.has(event)) mark = { entry: false, restart: false };
    else if (event === 'launch_failed' && row.action === 'retry') mark = { entry: true, restart: true };
    else if (event === 'task_outcome' && outcome !== null && MEMBER_RETRY_OUTCOMES.has(outcome)) mark = { entry: true, restart: true };
    if (mark === null) continue;
    const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
    const raw = row.ts ?? row.timestamp ?? row.at ?? row.time ?? row.mergedAt ?? row.closedAt ?? row.recordedAt ?? row.updatedAt;
    const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
    if (typeof id !== 'string' || !Number.isFinite(time) || time > at.getTime()) continue;
    const list = marks.get(id) ?? [];
    list.push({ at: time, ...mark });
    marks.set(id, list);
  }
  /** Current queue-dwell start for one job: the first entry mark after its last departure. */
  const arrivalOf = (id: string): number | null => {
    let arrival: number | null = null;
    for (const mark of marks.get(id) ?? []) {
      if (!mark.entry) arrival = null;
      else if (mark.restart || arrival === null) arrival = mark.at;
    }
    return arrival;
  };
  const byLane = new Map(queue.byLane.map(row => [row.lane, row]));
  const readyTotal = queue.health?.counts.ready ?? null;
  const parkedTotal = queue.health?.counts.parked ?? null;
  const readyKnown = readyTotal !== null;
  // Budget- and hold-only lanes carry no queue activity; leave them out.
  const lanes = new Set([
    ...byLane.keys(),
    ...snapshot.lanes.filter(v => (v.liveJobs ?? 0) > 0 || (v.mergesPerHour ?? 0) > 0).map(v => v.lane),
  ]);
  const rows: LaneQueueCountsRow[] = [...lanes].map(lane => {
    const view = snapshot.lanes.find(v => v.lane === lane);
    const counts = byLane.get(lane);
    const jobs = waiting.get(lane) ?? [];
    // The oldest wait is the earliest current-dwell arrival; any waiting job
    // whose arrival is unevidenced makes the lane's oldest wait unknown.
    let oldestArrival: number | null = null;
    let waitUnknown = jobs.length === 0;
    for (const id of jobs) {
      const arrival = arrivalOf(id);
      if (arrival === null) { waitUnknown = true; break; }
      if (oldestArrival === null || arrival < oldestArrival) oldestArrival = arrival;
    }
    const oldestWaitSeconds = metrics.state === 'healthy' && queue.sources.ready === 'healthy' && !waitUnknown && oldestArrival !== null
      ? Math.floor((at.getTime() - oldestArrival) / 1000) : null;
    const reasonCounts = new Map<string, number>();
    for (const g of readyKnown ? queue.groups : []) {
      if (g.lane === lane) reasonCounts.set(g.reason, (reasonCounts.get(g.reason) ?? 0) + g.count);
    }
    return {
      lane,
      blockedReasons: rankReasons(reasonCounts),
      stale: readyKnown ? (queue.metDeps ?? []).filter(d => d.lane === lane).length : null,
      ready: readyKnown ? counts?.ready ?? 0 : null,
      parked: readyKnown ? counts?.parked ?? 0 : null,
      running: view?.liveJobs ?? null,
      // Window is exactly one hour, so the per-hour rate is the count.
      merges: view?.mergesPerHour ?? null,
      oldestWaitSeconds,
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
  const totalReasons = new Map<string, number>();
  for (const row of rows) for (const r of row.blockedReasons) totalReasons.set(r.reason, (totalReasons.get(r.reason) ?? 0) + r.count);
  const runningState: QueueCountsSourceState = snapshot.sources.queueState.state === 'healthy' || snapshot.sources.queue.state === 'healthy'
    ? 'healthy' : snapshot.sources.queueState.state === 'degraded' || snapshot.sources.queue.state === 'degraded' ? 'degraded' : 'missing';
  const sources = { ready: queue.sources.ready, running: runningState, ledger: snapshot.sources.ledger.state };
  const notes: string[] = [];
  const say = (what: string, state: QueueCountsSourceState, effect: string) => {
    if (state === 'missing') notes.push(`${what} not found: ${effect}.`);
    else if (state === 'degraded' || state === 'unavailable') notes.push(`${what} is unreadable or has malformed rows: ${effect}.`);
  };
  say('queue/ready.tsv', sources.ready, 'ready, parked and blocked reasons are unknown');
  say('queue state (queue.v1.json)', sources.running, 'running counts are unknown');
  say('merge ledger (jobs.jsonl)', sources.ledger, 'merges are unknown');
  say('metrics/jobs.jsonl', metrics.state, 'oldest waits are unknown');
  return {
    schema: 'fleet.queue-counts.v1',
    generatedAt: at.toISOString(),
    windowMinutes: 60,
    totals: {
      ready: readyTotal,
      parked: parkedTotal,
      running: (snapshot.sources.queueState.state === 'healthy' || snapshot.sources.queue.state === 'healthy') && rows.every(r => r.running !== null) ? sum(rows, 'running') : null,
      merges: snapshot.sources.ledger.state === 'healthy' && rows.every(r => r.merges !== null) ? sum(rows, 'merges') : null,
      blockedReasons: rankReasons(totalReasons),
      stale: readyKnown ? sum(rows, 'stale') : null,
    },
    sources,
    notes,
    lanes: rows,
  };
}
