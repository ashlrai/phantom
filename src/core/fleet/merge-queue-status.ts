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
