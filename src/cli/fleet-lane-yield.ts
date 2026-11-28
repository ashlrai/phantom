/** Read-only yield per lane from the host jobs ledger. Exit 1 when any lane is red. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { isNodePoolLedgerRow, isPrecheckSkipRow, ledgerEventTs, ledgerJobId, ledgerLifecycleEvent } from '../core/fleet/jobs-ledger-dialect.js';
import { ledgerLane, ledgerPhase } from '../core/fleet/empty-cause.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet lane-yield [--hours 2] [--json]';
const RED_MIN_ROWS = 10;

/** Terminal "no work" phases: the fleet's empty-outcome vocabulary, the same set the other lane-yield folds apply. */
const EMPTY_PHASES: ReadonlySet<string> = new Set(['DONE-NOOP', 'EMPTY', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP']);
/** Named events that can carry a resolved PR phase or an empty verdict. */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'result', 'resolved', 'resolution']);
const FINISH_EVENTS: ReadonlySet<string> = new Set(['finish', 'finished', 'complete', 'completed']);
/**
 * RQ-BATCH-* ids are batch-session infrastructure, not jobs: the session's own
 * launch/finish rows carry aggregate evidence no lane job owns — the same reason
 * every sibling yield reader skips the prefix.
 */
const BATCH_SESSION_PREFIX = 'RQ-BATCH-';

/**
 * Merge evidence, the same rule lane-yield-weight and lane-yield-verdict apply:
 * a `merged: true` flag, a 'merged' event name, or a MERGED phase on an
 * outcome-ish row — 'outcome' (named or phase-inferred, which covers reconciler
 * rows), 'publish' (a reconciler row copied from a publish row keeps its event)
 * or the wider outcome event names. GitHub-resolved merges arrive through the
 * metrics-outcomes reconciler in exactly these spellings.
 */
const mergeEvidence = (row: Record<string, unknown>, event: string | null, phase: string): boolean =>
  row['merged'] === true || event === 'merged'
  || (phase === 'MERGED' && event !== null && (event === 'publish' || OUTCOME_EVENTS.has(event)));

/** Empty evidence: `empty: true` on a finish or outcome-ish row, or a terminal no-work phase on an outcome row. */
const emptyEvidence = (row: Record<string, unknown>, event: string | null, phase: string): boolean =>
  row.launched !== false && event !== null && (
    (FINISH_EVENTS.has(event) && row['empty'] === true)
    || (OUTCOME_EVENTS.has(event) && (row['empty'] === true || EMPTY_PHASES.has(phase))));

export interface LaneYieldRow {
  lane: string;
  launches: number;
  /** Precheck-decline rows (precheck_skip or code-carrying skipped_empty) keyed by their code ("none" when a row has no code). */
  skips_by_code: Record<string, number>;
  skips: number;
  empty_finishes: number;
  merged: number;
  /** All jobs-ledger rows seen for the lane in the window (node-pool and batch-session machinery excluded); the red test uses this. */
  rows: number;
  /** merged / (launches + skips); null when there are neither. */
  yield: number | null;
  red: boolean;
}
export interface LaneYieldReport {
  schema: 'fleet.lane-yield.v1';
  window_hours: number;
  /** false when the ledger could not be read; lanes is then empty and red false. */
  known: boolean;
  red: boolean;
  lanes: LaneYieldRow[];
}

/**
 * Counts merged once per job, since outcome rows repeat; a row's lane comes from
 * itself or its job's launch row. Rows fold through the shared jobs-ledger
 * dialect (jobs-ledger-dialect.ts, empty-cause.ts): job|job_id|jobId|id ids,
 * event|type|kind names, phase|state|outcome|status|result|conclusion phases,
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt stamps and the
 * lane|pool|arm aliases, so reconciler and eval/batcher rows count the same way
 * the other yield readers count them.
 */
export async function fleetLaneYield(read: TaskCheckReader = readTaskCheckJobs, hours = 2, now = Date.now()): Promise<LaneYieldReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: LaneYieldReport = { schema: 'fleet.lane-yield.v1', window_hours: hours, known: false, red: false, lanes: [] };
  let raw: string | null;
  try { raw = await read(); } catch { raw = null; }
  if (raw === null) return report;
  const parsed: { row: Record<string, unknown>; id: string | null; at: number; event: string | null; phase: string }[] = [];
  const launchLane = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (isNodePoolLedgerRow(r)) continue;
    const id = ledgerJobId(r);
    if (id !== null && id.startsWith(BATCH_SESSION_PREFIX)) continue;
    const phaseValue = ledgerPhase(r);
    const event = ledgerLifecycleEvent(r, phaseValue);
    const at = ledgerEventTs(r, phaseValue);
    if (at === null) continue;
    const lane = ledgerLane(r);
    if (event === 'launch' && id !== null && lane !== null) launchLane.set(id, lane);
    parsed.push({ row: r, id, at, event, phase: phaseValue ?? '' });
  }
  const lanes = new Map<string, LaneYieldRow>();
  const mergedJobs = new Set<string>();
  for (const { row, id, at, event, phase } of parsed) {
    if (at > now || at < now - hours * 3_600_000) continue;
    const name = ledgerLane(row) ?? (id === null ? null : launchLane.get(id)) ?? 'unknown';
    const entry = lanes.get(name) ?? { lane: name, launches: 0, skips_by_code: {}, skips: 0, empty_finishes: 0, merged: 0, rows: 0, yield: null, red: false };
    lanes.set(name, entry);
    entry.rows++;
    if (event === 'launch') entry.launches++;
    else if (isPrecheckSkipRow(row)) {
      const code = row.code === undefined || row.code === null ? 'none' : String(row.code);
      entry.skips_by_code[code] = (entry.skips_by_code[code] ?? 0) + 1;
      entry.skips++;
    } else if (mergeEvidence(row, event, phase)) {
      // A merge receipt that cannot add a new job (repeated outcome row, or no
      // job id to dedupe on) still blocks the empty check — merged dominates.
      if (id !== null && !mergedJobs.has(id)) { mergedJobs.add(id); entry.merged++; }
    } else if (emptyEvidence(row, event, phase)) entry.empty_finishes++;
  }
  for (const entry of lanes.values()) {
    const attempts = entry.launches + entry.skips;
    entry.yield = attempts > 0 ? entry.merged / attempts : null;
    entry.red = entry.rows >= RED_MIN_ROWS && entry.skips * 2 > entry.rows;
  }
  report.known = true;
  report.lanes = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
  report.red = report.lanes.some(entry => entry.red);
  return report;
}

export async function cmdFleetLaneYield(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPer lane, count launches, precheck skips by code, empty finishes and MERGED outcomes (joined to the lane through the job's launch row) in the window. Yield is merged over launches plus skips. A lane is red when skips are over half of its ${RED_MIN_ROWS}+ rows; exit 1 on red. Reads ~/.ashlr-runs/metrics/jobs.jsonl; unreadable metrics are unknown (exit 0).`);
    return 0;
  }
  let hours = 2, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetLaneYield(read, hours, now);
  const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const codes = (r: LaneYieldRow) => Object.entries(r.skips_by_code).sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c}:${n}`).join(',');
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(!report.known ? 'Lane yield: unknown (metrics unreadable)'
    : report.lanes.length === 0 ? `Lane yield: no rows in the last ${hours} hours`
    : report.lanes.map(r => `${r.lane}: yield ${pct(r.yield)} (${r.merged} merged / ${r.launches} launches + ${r.skips} skips${r.skips ? ` [${codes(r)}]` : ''}), ${r.empty_finishes} empty finishes${r.red ? ' RED' : ''}`).join('\n')));
  return report.red ? 1 : 0;
}
