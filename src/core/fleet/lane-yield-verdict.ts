/**
 * Lane yield verdict: did a lane's recent finished jobs produce anything?
 * Pure. A lane that ends almost every job empty has spare capacity but no
 * output, so remaps and free-capacity picks skip it unless the job names it.
 *
 *   unknown    fewer than 10 finished jobs in the window (never skipped)
 *   low-yield  20 or more finished jobs and empty_rate >= 0.8
 *   productive everything else
 */
import { parseLedgerTs } from '../metrics/loop.js';
import { hasRevertEvidence } from './slot-yield.js';

export const VERDICT_UNKNOWN_BELOW = 10;
export const VERDICT_LOW_MIN_JOBS = 20;
export const VERDICT_LOW_EMPTY_RATE = 0.8;

export type LaneVerdict = 'productive' | 'low-yield' | 'unknown';

/** One finished job. `at` is epoch ms, or null when the ledger had no usable time. */
export interface LaneJob { job: string; lane: string; at: number | null; empty: boolean; merged: boolean }

export interface LaneYieldStats {
  jobs: number;
  empty: number;
  merged: number;
  empty_rate: number | null;
  merged_per_job: number | null;
  verdict: LaneVerdict;
}

export interface YieldWindow { since: number; until?: number }

const round = (n: number): number => Math.round(n * 1000) / 1000;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Count one lane's finished jobs in the window. Rows that are not objects or lack a lane are
 * skipped, never fatal. With a window, a row without a usable time is outside it.
 */
export function laneYield(jobs: readonly unknown[], lane: string, window?: YieldWindow): LaneYieldStats {
  let n = 0, empty = 0, merged = 0;
  for (const row of jobs) {
    if (!isObject(row) || row.lane !== lane) continue;
    const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null;
    if (window && (at === null || at < window.since || (window.until !== undefined && at > window.until))) continue;
    n++;
    if (row.merged === true) merged++;
    else if (row.empty === true) empty++;
  }
  const known = n >= VERDICT_UNKNOWN_BELOW;
  const rate = n ? empty / n : null;
  const verdict: LaneVerdict = !known ? 'unknown'
    : n >= VERDICT_LOW_MIN_JOBS && rate !== null && rate >= VERDICT_LOW_EMPTY_RATE ? 'low-yield' : 'productive';
  return { jobs: n, empty, merged, empty_rate: n ? round(empty / n) : null, merged_per_job: n ? round(merged / n) : null, verdict };
}

/**
 * jobs.jsonl field dialects, the same sets lane-yield-weight.computeLaneYield,
 * visit-sync.classifyRow, queue/job-outcomes.parseJobOutcomeRows and
 * metrics/reward-feed.foldJobsLedgerRewards accept: job ids take
 * job|job_id|jobId|id, the event name event|type|kind ('published'
 * normalizes to 'publish'), the phase state|outcome|status plus the
 * producer aliases phase|result|conclusion, timestamps
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt (mergedAt/
 * closedAt preferred on terminal rows) and the lane aliases pool|arm.
 * Eventless
 * rows carrying a resolved PR phase (MERGED/CLOSED/OPEN) read as 'outcome',
 * the dispatchd _vc_event convention — that is how metrics-outcomes
 * reconciler rows (`jobId`/`prUrl`/`outcome`/`status` + `source`) arrive.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const TS_FIELDS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

/** Terminal "no work" phases: the fleet's empty-outcome vocabulary (skill-nudge EMPTY_PHASES, launch_precheck _TERMINAL_EMPTY). */
const EMPTY_PHASES: ReadonlySet<string> = new Set(['DONE-NOOP', 'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP']);
/** Named events that can carry a resolved PR phase or an empty verdict. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'result', 'resolved', 'resolution']);
const FINISH_EVENTS: ReadonlySet<string> = new Set(['finish', 'finished', 'complete', 'completed']);
const RESOLVED_PHASES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED', 'OPEN']);

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};
const phaseOf = (row: Record<string, unknown>): string => (firstString(row, PHASE_KEYS) ?? '').toUpperCase();

/** First parseable stamp among the ledger's timestamp fields; MERGED prefers mergedAt, CLOSED closedAt. */
const eventTs = (row: Record<string, unknown>, phase: string): number | null => {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred === null ? TS_FIELDS : [preferred, ...TS_FIELDS.filter(f => f !== preferred)];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
};

/** Named lifecycle event, or the phase-inferred 'outcome' for eventless resolved-PR rows. */
const ledgerEvent = (row: Record<string, unknown>, phase: string): string | null => {
  const named = firstString(row, EVENT_KEYS)?.toLowerCase() ?? null;
  if (named !== null) return named === 'published' ? 'publish' : named;
  return RESOLVED_PHASES.has(phase) ? 'outcome' : null;
};

/**
 * Merge evidence: a `merged: true` flag, a 'merged' event name, or a MERGED
 * phase on an outcome-ish row — 'outcome' (named or phase-inferred, which
 * covers reconciler rows), 'publish' (a reconciler row copied from a
 * publish row keeps its event) or the wider outcome event names.
 */
const mergeEvidence = (row: Record<string, unknown>, event: string | null, phase: string): boolean =>
  row['merged'] === true || event === 'merged'
  || (phase === 'MERGED' && event !== null
    && (event === 'publish' || OUTCOME_EVENTS.has(event)));

/** Empty evidence: `empty: true` on a finish or outcome-ish row, or a terminal no-work phase on an outcome row. */
const emptyEvidence = (row: Record<string, unknown>, event: string | null, phase: string): boolean =>
  event !== null && (
    (FINISH_EVENTS.has(event) && row['empty'] === true)
    || (OUTCOME_EVENTS.has(event) && (row['empty'] === true || EMPTY_PHASES.has(phase))));

/** Fold the jobs ledger into one record per finished job, on the lane of its latest launch. Bad lines are skipped. */
export function parseLaneJobs(ledger: string): LaneJob[] {
  type Launch = { lane: string; at: number };
  const launches = new Map<string, Launch>();
  const done = new Map<string, { at: number | null; empty: boolean; merged: boolean }>();
  const reverted = new Set<string>();
  for (const line of ledger.split('\n')) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row)) continue;
    const id = firstString(row, JOB_KEYS);
    if (!id) continue;
    const phase = phaseOf(row);
    const event = ledgerEvent(row, phase);
    const at = eventTs(row, phase);
    if (event === 'launch') {
      const lane = firstString(row, LANE_KEYS) ?? '';
      const prev = launches.get(id);
      if (lane && (!prev || (at ?? 0) >= prev.at)) launches.set(id, { lane, at: at ?? 0 });
      continue;
    }
    if (hasRevertEvidence(row)) reverted.add(id);
    const merged = mergeEvidence(row, event, phase);
    // A finish row always ends the job; an outcome-ish row ends it only when
    // it carries empty evidence — resolved non-merge outcomes (CLOSED, OPEN,
    // RECORDED) stay uncounted, as before.
    const finished = event !== null && (FINISH_EVENTS.has(event)
      || (OUTCOME_EVENTS.has(event) && (row['empty'] === true || EMPTY_PHASES.has(phase))));
    if (!merged && !finished) continue;
    const prev = done.get(id) ?? { at: null, empty: false, merged: false };
    done.set(id, { at: Math.max(prev.at ?? 0, at ?? 0) || null, empty: prev.empty || emptyEvidence(row, event, phase), merged: prev.merged || merged });
  }
  const out: LaneJob[] = [];
  for (const [job, d] of done) {
    const launch = launches.get(job);
    if (!launch) continue;
    const merged = d.merged && !reverted.has(job);
    out.push({ job, lane: launch.lane, at: d.at ?? (launch.at || null), merged, empty: d.empty && !merged });
  }
  return out;
}

/** Plain-words reason a low-yield lane is skipped, e.g. "skipped zai: 92 of 99 recent jobs ended empty". */
export function lowYieldReason(lane: string, stats: Pick<LaneYieldStats, 'jobs' | 'empty'>): string {
  return `skipped ${lane}: ${stats.empty} of ${stats.jobs} recent jobs ended empty`;
}

/** Stats for every lane in `lanes` plus any lane seen in the jobs. */
export function laneYieldAll(jobs: readonly LaneJob[], lanes: readonly string[], window?: YieldWindow): Array<{ lane: string } & LaneYieldStats> {
  const names = [...new Set([...lanes, ...jobs.map(j => j.lane)])].sort();
  return names.map(lane => ({ lane, ...laneYield(jobs, lane, window) }));
}
