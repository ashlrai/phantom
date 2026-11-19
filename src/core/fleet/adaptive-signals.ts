/**
 * Adaptive routing signals — the producer half of `queue/adaptive.json`.
 *
 * The shared work market (`work_market.lane_view` in contrib/mac/work_market.py)
 * accepts an optional host projection `{ts, lanes: {<lane>: {empty_rate,
 * yield_rate, model_latency_s, backoff}}}` and uses it only while `ts` is at
 * most 300 seconds old. Until now nothing produced that file, so `yield_rate`
 * — which has no finish-event fallback — stayed permanently neutral and the
 * market ranked every lane as if its measured outcome rate were unknown.
 *
 * This module computes the projection from the same job-metrics ledger
 * (`metrics/jobs.jsonl`) and the same launch tally (`yieldTally`) that
 * `phm fleet yield` uses, so the numbers an operator sees here are the fleet's
 * canonical merged-per-launch and empty rates, not a second accounting.
 *
 * Honesty rules:
 *  - `empty_rate` is finished runs flagged empty over finished runs; a lane
 *    with no finished run reports null (unknown), never 0.
 *  - `yield_rate` is merged runs over launches in the window — the
 *    `merged_per_launch` definition `fleet.yield.v1` already reports.
 *  - `model_latency_s` is the median `model_s` on finish rows only. Wall-clock
 *    `wall_s` is never relabelled as model latency: the market's own
 *    session_wall fallback already covers it, and its receipts distinguish
 *    the two sources.
 *  - `backoff` is always null. It is an eligibility exclusion, not an outcome
 *    statistic; only host slot evidence or an operator hold may set it, so a
 *    bad measurement can never silently throttle a lane.
 *  - An unreadable ledger yields `known: false` and `publish: null`; nothing
 *    is ever written from missing data.
 *
 * Pure: ledger lines in, report out. `readAdaptiveSignals` owns the file read
 * through the shared line reader; `src/cli/fleet-adaptive.ts` owns the write.
 */

import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { yieldTally, type YieldRun } from './slot-yield.js';

export const ADAPTIVE_SCHEMA = 'fleet.adaptive.v1';
/** The market ignores adaptive.json older than this many seconds. */
export const ADAPTIVE_FRESH_SECONDS = 300;
/** Same spelling bound slot-yield applies to ledger lane names. */
const LANE_WORD = /^[\w.:@/-]{1,80}$/;

/** One lane's entry in the published queue/adaptive.json `lanes` map. */
export interface AdaptiveLaneSignal {
  empty_rate: number | null;
  yield_rate: number | null;
  model_latency_s: number | null;
  backoff: null;
}

/** The report row: the published signals plus the sample counts behind them. */
export interface AdaptiveLaneReport extends AdaptiveLaneSignal {
  launches: number;
  finished: number;
  /** Finished runs the tally flags empty (finish `empty:true` or an `empty` publish). */
  empty: number;
  merged: number;
  model_latency_samples: number;
}

/** The exact `queue/adaptive.json` content `--apply` writes. */
export interface AdaptivePublish {
  /** Epoch seconds; the market treats the file as fresh for ADAPTIVE_FRESH_SECONDS. */
  ts: number;
  lanes: Record<string, AdaptiveLaneSignal>;
}

/** `known: false` means the ledger could not be read: no lanes, no publish payload. */
export interface AdaptiveReport {
  schema: typeof ADAPTIVE_SCHEMA;
  known: boolean;
  window_hours: number;
  generated_at: string;
  lanes: Record<string, AdaptiveLaneReport>;
  publish: AdaptivePublish | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Same median slot-yield's summarize uses (average of the two middles on even counts). */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Same timestamp normalization yieldTally applies to ledger rows. */
function rowTime(row: Record<string, unknown>): number {
  const ts = row.ts;
  return typeof ts === 'string' ? Date.parse(ts.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
}

/**
 * `model_s` observations per lane from finish rows. The field is sparse — most
 * finish rows carry only `wall_s` — so a line is parsed only when it can
 * contain the key. Rows older than the window start are skipped exactly like
 * the tally skips them; rows without a usable lane or a non-negative number
 * are ignored, like the market's own `number(o.get("model_s"))` check.
 */
function modelLatencyProbe(line: string, out: Map<string, number[]>, start: number): void {
  if (!line.includes('model_s')) return;
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  if (!isRecord(row) || row.event !== 'finish') return;
  const at = rowTime(row);
  if (Number.isFinite(at) && at < start) return;
  // Same lane normalization the tally applies (`word` in slot-yield.ts).
  const lane = typeof row.lane === 'string' && LANE_WORD.test(row.lane.trim()) ? row.lane.trim() : 'unknown';
  const modelS = typeof row.model_s === 'number' && Number.isFinite(row.model_s) && row.model_s >= 0 ? row.model_s : null;
  if (modelS === null) return;
  const list = out.get(lane);
  if (list) list.push(modelS); else out.set(lane, [modelS]);
}

function laneReport(runs: readonly YieldRun[], latency: readonly number[]): AdaptiveLaneReport {
  const finishedRuns = runs.filter(r => r.finished);
  const finished = finishedRuns.length;
  const empty = finishedRuns.filter(r => r.empty).length;
  const merged = runs.filter(r => r.merged).length;
  return {
    launches: runs.length,
    finished,
    empty,
    merged,
    empty_rate: finished ? empty / finished : null,
    yield_rate: runs.length ? merged / runs.length : null,
    model_latency_s: median([...latency]),
    model_latency_samples: latency.length,
    backoff: null,
  };
}

function reportFromRuns(runs: readonly YieldRun[], latencies: ReadonlyMap<string, readonly number[]>, now: number, hours: number): AdaptiveReport {
  const byLane = new Map<string, YieldRun[]>();
  for (const run of runs) {
    const members = byLane.get(run.lane);
    if (members) members.push(run); else byLane.set(run.lane, [run]);
  }
  const rows = [...byLane.entries()]
    .map(([name, laneRuns]) => ({ name, report: laneReport(laneRuns, latencies.get(name) ?? []) }))
    .sort((a, b) => b.report.launches - a.report.launches || a.name.localeCompare(b.name));
  const lanes: Record<string, AdaptiveLaneReport> = {};
  const publishLanes: Record<string, AdaptiveLaneSignal> = {};
  for (const { name, report } of rows) {
    lanes[name] = report;
    publishLanes[name] = {
      empty_rate: report.empty_rate,
      yield_rate: report.yield_rate,
      model_latency_s: report.model_latency_s,
      backoff: null,
    };
  }
  return {
    schema: ADAPTIVE_SCHEMA,
    known: true,
    window_hours: hours,
    generated_at: new Date(now).toISOString(),
    lanes,
    publish: { ts: Math.floor(now / 1000), lanes: publishLanes },
  };
}

/** Pure: job metric ledger lines (launch, finish, publish, outcome) in, report out. */
export function adaptiveSignals(lines: Iterable<string>, now: number, hours: number): AdaptiveReport {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const tally = yieldTally(now, hours);
  const start = now - hours * 3_600_000;
  const latencies = new Map<string, number[]>();
  for (const line of lines) {
    tally.add(line);
    modelLatencyProbe(line, latencies, start);
  }
  return reportFromRuns(tally.runs(), latencies, now, hours);
}

export function unknownAdaptive(hours: number, now = Date.now()): AdaptiveReport {
  return { schema: ADAPTIVE_SCHEMA, known: false, window_hours: hours,
    generated_at: new Date(now).toISOString(), lanes: {}, publish: null };
}

/** Stream a metrics file through the shared tally; an unreadable file is unknown, never zero. */
export async function readAdaptiveSignals(path: string, hours: number, now: number, read: YieldLineReader = readLedgerLines): Promise<AdaptiveReport> {
  const tally = yieldTally(now, hours);
  const start = now - hours * 3_600_000;
  const latencies = new Map<string, number[]>();
  const ok = await read(path, line => { tally.add(line); modelLatencyProbe(line, latencies, start); });
  return ok ? reportFromRuns(tally.runs(), latencies, now, hours) : unknownAdaptive(hours, now);
}
