/**
 * job-outcomes.ts — collapse metrics/jobs.jsonl into the latest outcome per
 * job, the "recent outcomes" signal queue generators consult before they
 * re-emit a candidate.
 *
 * dispatchd appends one JSON row per event: `finish` rows carry the diff
 * measurement (`empty`), `outcome` rows carry the PR state (`MERGED`). Rows
 * for one job collapse into a single JobOutcome: `merged` is the stronger
 * terminal fact and wins over a stale `empty` flag, and `empty` is the
 * newest boolean `empty` seen (unmeasured rows leave it null, never a guess).
 *
 * Only rows inside `windowMs` of `now` count — older rows are stale evidence
 * and prove nothing about the candidate as it stands now. Malformed lines,
 * missing ids and unparseable or out-of-window timestamps are skipped, never
 * thrown: an unreadable row must not take down generation.
 */
import { parseLedgerTs } from '../metrics/loop.js';

export interface JobOutcome {
  /** Queue job id, e.g. RQ-FIXUP-phantom-1-aaaaaaa. */
  job: string;
  /** Epoch ms of the newest row seen for this job. */
  at: number;
  /** The attempt produced no diff; null when no row measured it. */
  empty: boolean | null;
  /** The job's PR merged. */
  merged: boolean;
}

// The fleet's canonical empty finish kinds (lane-empty-streak.ts EMPTY_KINDS):
// an outcome row naming any of these is a proven empty attempt. NOOP is the
// extra phase word skill-nudge's EMPTY_PHASES recognizes, and SKIPPED is the
// batch member's task_outcome verdict for "checked off, no work needed"
// (batcher.py OUTCOMES). The snake_case spellings SKIPPED_EMPTY/PRECHECK_SKIP
// stay out on purpose: they arrive as event names and only the guarded
// SKIP_EMPTY_EVENTS path below may mark them — a skip row carrying
// `applied: false` is the skip gate's dry run and the job still launched
// (empties.ts SKIP_EVENTS applies the same guard).
const TERMINAL_EMPTY = new Set(['EMPTY', 'DONE-NOOP', 'EMPTY_DONE', 'SKIPPED-EMPTY', 'NOOP', 'SKIPPED']);
const SKIP_EMPTY_EVENTS: ReadonlySet<string> = new Set(['skipped_empty', 'precheck_skip']);
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
};

/**
 * Latest-known outcome per job id. `empty`/`merged` keep their verdicts even
 * when the newest row for the job did not carry that field; `at` always
 * tracks the newest counted row.
 */
export function collapseJobOutcomes(rows: readonly JobOutcome[]): Map<string, JobOutcome> {
  const latest = new Map<string, JobOutcome>();
  for (const row of rows) {
    const prev = latest.get(row.job);
    if (prev === undefined || row.at >= prev.at) {
      latest.set(row.job, {
        job: row.job,
        at: row.at,
        empty: row.merged ? false : row.empty ?? (prev?.empty ?? null),
        merged: row.merged || (prev?.merged ?? false),
      });
    } else if (row.merged) {
      prev.merged = true;
      prev.empty = false;
    } else if (row.empty !== null && prev.empty === null) {
      prev.empty = row.empty;
    }
  }
  return latest;
}

/**
 * Parse jobs.jsonl text. Rows count only when they name a job and carry a
 * timestamp inside (now-windowMs, now]; everything else is skipped so a
 * torn tail or an unrelated metric row can never fabricate evidence.
 *
 * Field coverage mirrors the fleet's canonical ledger dialects
 * (agent-activity.ts parseLedger, queue/visit-sync.ts classifyRow,
 * metrics-outcomes.ts reconciler rows): job ids accept job|job_id|jobId|id;
 * the phase reads state|outcome|status plus the producer aliases
 * phase|result|conclusion before the event name; the event name
 * accepts event|type|kind; timestamps prefer mergedAt/closedAt on terminal
 * rows, then ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt,
 * first parseable wins (visit-sync.ts eventTs).
 */
export function parseJobOutcomeRows(raw: string, now: number, windowMs: number): JobOutcome[] {
  const rows: JobOutcome[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    const job = firstString(value, JOB_KEYS);
    const eventRaw = firstString(value, EVENT_KEYS);
    if (eventRaw === 'wiki_slice') continue;
    const phase = (firstString(value, PHASE_KEYS) ?? eventRaw ?? '').toUpperCase();
    const preferredTs = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
    const stampFields = preferredTs === null ? TS_KEYS : [preferredTs, ...TS_KEYS.filter((key) => key !== preferredTs)];
    let at = NaN;
    for (const key of stampFields) {
      const parsed = parseLedgerTs(value[key]);
      if (parsed !== null) { at = parsed; break; }
    }
    if (job === null || !Number.isFinite(at)) continue;
    if (at < now - windowMs || at > now) continue;
    const eventName = eventRaw?.toLowerCase() ?? null;
    const merged = phase === 'MERGED' || eventName === 'merged';
    const skipEmpty = eventName !== null && SKIP_EMPTY_EVENTS.has(eventName) && value['applied'] !== false;
    const rawEmpty = value['empty'];
    const empty = merged ? false
      : skipEmpty ? true
      : typeof rawEmpty === 'boolean' ? rawEmpty
      : TERMINAL_EMPTY.has(phase) ? true
      : null;
    rows.push({ job, at, empty, merged });
  }
  return rows;
}
