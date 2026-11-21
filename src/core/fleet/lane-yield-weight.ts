/**
 * Lane yield weight: how often a lane's recent launches ended as a merged PR.
 * Pure; the caller reads `metrics/jobs.jsonl` and passes its text.
 *
 * Per lane and size (a launch row's `size`, else "unknown"), plus a per-lane
 * "all" row, the window is the lane's last 50 launches. A job's merge and empty
 * finish count once, on its latest launch. Rows fold through the fleet's
 * jobs-ledger dialect (see the field sets below computeLaneYield): reconciler
 * outcome rows keyed by `jobId`/`prUrl`/`outcome`/`status`, `type`/`kind`
 * event spellings, the `pool` lane alias and terminal empty phases
 * (DONE-NOOP and kin) all count, so GitHub-resolved merges are not invisible.
 * A merge recorded as reverted
 * (`hasRevertEvidence`, the router outcome fold's vocabulary) counts as
 * `reverted`, never as a held merge. Fewer than 10 launches in the window
 * is unknown, and unknown gets the neutral weight 1.
 *
 * weight = yield / 0.5, clamped to 0.1..2, so a yield of 0.5 is exactly neutral.
 */
import { parseLedgerTs } from '../metrics/loop.js';
import { hasRevertEvidence } from './slot-yield.js';

export const LANE_YIELD_SCHEMA = 'lanes.yield.v1';
export const YIELD_WINDOW_JOBS = 50;
export const YIELD_MIN_JOBS = 10;
/** A known yield at or above this counts as high; below it is low. */
export const YIELD_HIGH = 0.5;
export const NEUTRAL_WEIGHT = 1;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 2;

export interface LaneYieldRow {
  lane: string;
  /** Launch size ("sm", "md", ...), "unknown" when the launch row has none, or "all". */
  size: string;
  launches: number;
  merged: number;
  /** Launches whose merge was recorded as reverted; never counted in `merged`. */
  reverted: number;
  empty: number;
  /** merged / launches; null below the minimum. */
  yield: number | null;
  /** empty / launches; null below the minimum. */
  emptyRate: number | null;
  /** The number the router uses. */
  weight: number;
  known: boolean;
}

export interface LaneYieldReport {
  schema: typeof LANE_YIELD_SCHEMA;
  /** false when the ledger could not be read; rows is then empty. */
  known: boolean;
  windowJobs: number;
  minJobs: number;
  highYield: number;
  rows: LaneYieldRow[];
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * jobs.jsonl field dialects, the same sets visit-sync.classifyRow,
 * queue/job-outcomes.parseJobOutcomeRows, agent-activity.parseLedger,
 * job-latency.boundaryEvent, fleet/throughput.marksOf and
 * metrics/reward-feed.foldJobsLedgerRewards accept: job ids take
 * job|job_id|jobId|id, the event name event|type|kind ('published'
 * normalizes to 'publish'), the phase state|outcome|status, timestamps
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt (mergedAt/
 * closedAt preferred on terminal rows) and the lane alias pool. Eventless
 * rows carrying a resolved PR phase (MERGED/CLOSED/OPEN) read as 'outcome',
 * the dispatchd _vc_event convention — that is how metrics-outcomes
 * reconciler rows (`jobId`/`prUrl`/`outcome`/`status` + `source`) arrive.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status'] as const;
const LANE_KEYS = ['lane', 'pool'] as const;
const TS_FIELDS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

/** Terminal "no work" phases: the fleet's empty-outcome vocabulary (skill-nudge EMPTY_PHASES, launch_precheck _TERMINAL_EMPTY). */
const EMPTY_PHASES: ReadonlySet<string> = new Set(['DONE-NOOP', 'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP']);
/** Named events that can carry a resolved PR phase or an empty verdict. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'result', 'resolved', 'resolution']);
const FINISH_EVENTS: ReadonlySet<string> = new Set(['finish', 'finished', 'complete', 'completed']);
const RESOLVED_PHASES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED', 'OPEN']);

const firstString = (row: Row, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};
const phaseOf = (row: Row): string => (firstString(row, PHASE_KEYS) ?? '').toUpperCase();

/** First parseable stamp among the ledger's timestamp fields; MERGED prefers mergedAt, CLOSED closedAt. */
const eventTs = (row: Row, phase: string): number | null => {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred === null ? TS_FIELDS : [preferred, ...TS_FIELDS.filter(f => f !== preferred)];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
};

/** Named lifecycle event, or the phase-inferred 'outcome' for eventless resolved-PR rows. */
const ledgerEvent = (row: Row, phase: string): string | null => {
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
const mergeEvidence = (row: Row, event: string | null, phase: string): boolean =>
  row['merged'] === true || event === 'merged'
  || (phase === 'MERGED' && event !== null
    && (event === 'publish' || OUTCOME_EVENTS.has(event)));

/** Empty evidence: `empty: true` on a finish or outcome-ish row, or a terminal no-work phase on an outcome row. */
const emptyEvidence = (row: Row, event: string | null, phase: string): boolean =>
  event !== null && (
    (FINISH_EVENTS.has(event) && row['empty'] === true)
    || (OUTCOME_EVENTS.has(event) && (row['empty'] === true || EMPTY_PHASES.has(phase))));

export function yieldWeight(yieldRate: number | null): number {
  if (yieldRate === null) return NEUTRAL_WEIGHT;
  return Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, yieldRate / YIELD_HIGH)) * 100) / 100;
}

export function computeLaneYield(ledger: string | null): LaneYieldReport {
  const report: LaneYieldReport = { schema: LANE_YIELD_SCHEMA, known: ledger !== null, windowJobs: YIELD_WINDOW_JOBS, minJobs: YIELD_MIN_JOBS, highYield: YIELD_HIGH, rows: [] };
  if (ledger === null) return report;
  type Launch = { lane: string; size: string; at: number; seq: number; merged: boolean; reverted: boolean; empty: boolean };
  const launches: Launch[] = [];
  const byJob = new Map<string, Launch[]>();
  const merged = new Set<string>();
  const reverted = new Set<string>();
  const empty = new Set<string>();
  let seq = 0;
  for (const line of ledger.split('\n')) {
    let row: Row;
    try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) continue; row = value as Row; } catch { continue; }
    const id = firstString(row, JOB_KEYS);
    if (!id) continue;
    const phase = phaseOf(row);
    const event = ledgerEvent(row, phase);
    if (event === 'launch') {
      const lane = firstString(row, LANE_KEYS);
      if (!lane) continue;
      const at = eventTs(row, phase);
      const launch: Launch = { lane, size: text(row.size) ?? 'unknown', at: at ?? 0, seq: seq++, merged: false, reverted: false, empty: false };
      launches.push(launch);
      byJob.set(id, [...(byJob.get(id) ?? []), launch]);
    } else {
      if (mergeEvidence(row, event, phase)) merged.add(id);
      else if (emptyEvidence(row, event, phase)) empty.add(id);
      if (hasRevertEvidence(row)) reverted.add(id);
    }
  }
  for (const [id, runs] of byJob) {
    const last = runs.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.seq > a.seq) ? b : a));
    if (reverted.has(id)) last.reverted = true;
    else if (merged.has(id)) last.merged = true;
    else if (empty.has(id)) last.empty = true;
  }
  launches.sort((a, b) => b.at - a.at || b.seq - a.seq);
  const groups = new Map<string, Launch[]>();
  const add = (lane: string, size: string, launch: Launch): void => {
    const key = JSON.stringify([lane, size]);
    const list = groups.get(key) ?? [];
    if (list.length < YIELD_WINDOW_JOBS) { list.push(launch); groups.set(key, list); }
  };
  for (const launch of launches) { add(launch.lane, launch.size, launch); add(launch.lane, 'all', launch); }
  for (const [key, list] of groups) {
    const [lane, size] = JSON.parse(key) as [string, string];
    const wins = list.filter(l => l.merged).length;
    const reverted = list.filter(l => l.reverted).length;
    const empties = list.filter(l => l.empty).length;
    const known = list.length >= YIELD_MIN_JOBS;
    const yieldRate = known ? wins / list.length : null;
    report.rows.push({ lane, size, launches: list.length, merged: wins, reverted, empty: empties, yield: yieldRate,
      emptyRate: known ? empties / list.length : null, weight: yieldWeight(yieldRate), known });
  }
  report.rows.sort((a, b) => a.lane.localeCompare(b.lane) || (a.size === 'all' ? -1 : b.size === 'all' ? 1 : a.size.localeCompare(b.size)));
  return report;
}

/** The row the router reads for a lane and size; absent means unknown and neutral. */
export function laneYieldFor(rows: readonly LaneYieldRow[] | undefined, lane: string, size: string): LaneYieldRow | null {
  return rows?.find(r => r.lane === lane && r.size === size) ?? null;
}
