/**
 * jobs-ledger-dialect.ts — the lifecycle-row accessors cleanup readers share.
 *
 * metrics/jobs.jsonl is written by several producers in several dialects:
 * dispatchd rows use job/event/ts, the metrics-outcomes reconciler copies the
 * PUBLISHED row verbatim (jobId/prUrl/outcome/mergedAt + source) and may keep
 * a publish-shaped event while carrying a terminal phase, and eval/batcher
 * rows spell the same facts as type|kind, phase|state|outcome|status|
 * result|conclusion and timestamp|at|time|mergedAt|closedAt|recordedAt|
 * updatedAt. These helpers resolve one row's job id, lifecycle event,
 * timestamp and outcome state across that dialect so readers stop
 * re-implementing (and missing) the same folds. Field pickers come from
 * empty-cause.ts; the event/phase/url key sets are the canonical ones
 * metrics/loop, slot-yield and dispatchd `_vc_pick`/`_vc_event` accept.
 */
import { parseLedgerTs } from '../metrics/loop.js';
import { ledgerEventName } from './empty-cause.js';

/** job|job_id|jobId|id — the same set empty-cause.ledgerRows folds on. */
const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;

const pickString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

/** Job id across job|job_id|jobId|id — first non-empty string. */
export function ledgerJobId(row: Record<string, unknown>): string | null {
  return pickString(row, JOB_ID_KEYS);
}

/**
 * Phases that prove a PR reached a verdict. dispatchd `_vc_event` infers an
 * 'outcome' event for eventless rows carrying one of these (and 'publish' for
 * PUBLISHED); OPEN is included so an eventless open claim still resolves.
 */
const RESOLVED_PHASES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED', 'OPEN']);
/** Terminal verdicts a metrics-outcomes reconciler row may carry on a publish-shaped event. */
const TERMINAL_PHASES: ReadonlySet<string> = new Set(['MERGED', 'CLOSED']);
/** Named events whose phase is a resolved job outcome (slot-yield's set). */
const OUTCOME_EVENTS: ReadonlySet<string> = new Set(['outcome', 'result', 'resolved', 'resolution']);
/** Reconciler rows are the only publish-shaped rows allowed to carry outcome evidence. */
const RECONCILER_SOURCE = 'metrics-outcomes-reconciler';

/**
 * Lifecycle event for dialect readers: the named event|type|kind ('published'
 * folds to 'publish' via ledgerEventName), else inferred from the phase —
 * PUBLISHED reads as a publish claim and a resolved phase as a reconciled
 * outcome, the dispatchd _vc_event convention. Null for operational rows and
 * eventless rows with no phase.
 */
export function ledgerLifecycleEvent(row: Record<string, unknown>, phase: string | null): string | null {
  const named = ledgerEventName(row);
  if (named !== null) return named;
  if (phase === 'PUBLISHED') return 'publish';
  return phase !== null && RESOLVED_PHASES.has(phase) ? 'outcome' : null;
}

/**
 * First parseable stamp among ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt; a MERGED row prefers mergedAt and CLOSED closedAt —
 * the same terminal preference metrics/loop.eventTs applies.
 */
export function ledgerEventTs(row: Record<string, unknown>, phase: string | null): number | null {
  const preferred = phase === 'MERGED' ? 'mergedAt' : phase === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred === null ? TS_KEYS : [preferred, ...TS_KEYS.filter(f => f !== preferred)];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
}

/**
 * The job outcome a row resolves to, or null when it carries none. `merged:true`
 * and 'merged'/'closed' event names are verdicts on any row; outcome-bearing
 * events return their phase (an empty phase stays null so a phase-less row
 * never overwrites an earlier verdict). A resolved phase riding a
 * publish-shaped event counts only for metrics-outcomes reconciler rows —
 * batcher.project_row's convention — because a bare publish+phase row is a
 * publish claim, not lifecycle evidence.
 */
export function ledgerOutcomeState(row: Record<string, unknown>, event: string | null, phase: string | null): string | null {
  const ph = phase ?? '';
  if (row['merged'] === true || event === 'merged') return 'MERGED';
  if (event === 'closed') return ph !== '' ? ph : 'CLOSED';
  if (event !== null && OUTCOME_EVENTS.has(event)) return ph !== '' ? ph : null;
  if (event === 'publish' && row['source'] === RECONCILER_SOURCE && TERMINAL_PHASES.has(ph)) return ph;
  return null;
}
