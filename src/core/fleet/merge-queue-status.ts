import type { PreparationResult } from './merge-queue-prep.js';

export interface QueuePredecessor { number: number; headSha: string }
export interface QueueRevision {
  repo?: string;
  headSha?: string;
  baseSha?: string;
  predecessors?: readonly QueuePredecessor[];
  mergeGroupSha?: string;
}

export const fullQueueSha = (sha: unknown): sha is string =>
  typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);

function samePredecessors(a: QueueRevision['predecessors'], b: QueueRevision['predecessors']) {
  if (a === undefined && b === undefined) return true;
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, i) =>
    p && Number.isSafeInteger(p.number) && p.number > 0 && fullQueueSha(p.headSha)
    && p.number === b[i]?.number && p.headSha === b[i]?.headSha);
}

export function currentQueueChecks(current: QueueRevision, checked: QueueRevision | undefined) {
  return fullQueueSha(current.mergeGroupSha) && current.mergeGroupSha === checked?.mergeGroupSha
    && current.repo === checked.repo && current.headSha === checked.headSha && current.baseSha === checked.baseSha
    && samePredecessors(current.predecessors, checked.predecessors);
}

export function preparationStall(current: QueueRevision, prep: PreparationResult | undefined):
'base_movement' | 'content_conflict' | 'stack_wait' | 'unknown' {
  if (!fullQueueSha(prep?.baseSha) || prep.repo !== current.repo || prep.headSha !== current.headSha
    || !prep.predecessors || !samePredecessors(current.predecessors, prep.predecessors)
    || !['ready', 'conflict', 'deferred'].includes(prep.state)) return 'unknown';
  if (current.baseSha !== prep.baseSha) return 'base_movement';
  if (prep.state === 'conflict') return 'content_conflict';
  return prep.state === 'deferred' && prep.predecessors.length ? 'stack_wait' : 'unknown';
}

export type MergeQueueBlocker = 'queue' | 'required_checks' | 'conflict' | 'review' | 'other';
export interface MergeQueueObservation {
  type: string; at?: string; reason?: MergeQueueBlocker;
  required?: boolean; conclusion?: string;
}
export interface MergeQueueStatus {
  stage: MergeQueueBlocker | 'unknown' | 'merged' | 'closed';
  since: string | null;
  /** Current stage age; terminal states have no current delay. */
  waiting_s: number | null;
  /** Observed intervals only, not lifetime totals; unobserved stages stay null. */
  delays_s: Record<'queue' | 'required_checks' | 'conflict', number | null>;
}

/** Read-only observations. Queue admission and individual successes cannot clear blockers. */
export function mergeQueueStatus(events: readonly MergeQueueObservation[], now: number): MergeQueueStatus {
  const time = (e: MergeQueueObservation) => Date.parse(e.at ?? '');
  const terminal = events.filter(e => e.type === 'merged' || e.type === 'closed');
  const end = terminal.length ? terminal.length === 1 ? time(terminal[0]!) : NaN : now;
  const rows = events.filter(e => ['queued', 'eligible', 'blocked', 'conflict', 'checks_passed'].includes(e.type)
    || (e.type === 'check_observed' && e.required === true && e.conclusion !== 'success'));
  const unknown: MergeQueueStatus = { stage: terminal.some(e => e.type === 'merged') ? 'merged'
    : terminal.length ? 'closed' : 'unknown', since: null, waiting_s: null,
    delays_s: { queue: null, required_checks: null, conflict: null } };
  if (!Number.isFinite(now) || !Number.isFinite(end) || end > now || rows.some(e => !Number.isFinite(time(e)))) return unknown;
  const groups = new Map<number, MergeQueueObservation[]>();
  for (const e of rows) if (time(e) <= end) groups.set(time(e), [...(groups.get(time(e)) ?? []), e]);
  let stage: MergeQueueStatus['stage'] = 'unknown', start: number | null = null;
  const delays = { ...unknown.delays_s };
  const accrue = (until: number) => {
    if (start !== null && (stage === 'queue' || stage === 'required_checks' || stage === 'conflict')) {
      delays[stage] = (delays[stage] ?? 0) + (until - start) / 1000;
    }
  };
  for (const [at, group] of [...groups].sort(([a], [b]) => a - b)) {
    const explicit: MergeQueueStatus['stage'][] = group.filter(e => e.type !== 'queued' && (e.type !== 'checks_passed' || stage === 'required_checks')).map(e =>
      e.type === 'blocked' ? e.reason ?? 'unknown' : e.type === 'conflict' ? 'conflict'
      : e.type === 'eligible' ? 'queue'
      : e.type === 'check_observed' ? stage === 'conflict' ? stage : 'required_checks'
      : 'queue');
    const verdicts = [...new Set(explicit)];
    if (verdicts.length > 1) return unknown;
    const next: MergeQueueStatus['stage'] = verdicts[0] ?? (stage === 'unknown' && group.some(e => e.type === 'queued') ? 'queue' : stage);
    if (next === stage) continue;
    accrue(at);
    stage = next; start = at;
  }
  accrue(end);
  return { stage: terminal.length ? unknown.stage : stage,
    since: terminal.length ? new Date(end).toISOString() : start === null ? null : new Date(start).toISOString(),
    waiting_s: terminal.length || start === null ? null : (end - start) / 1000, delays_s: delays };
}
