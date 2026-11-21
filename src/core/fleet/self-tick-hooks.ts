/**
 * self-tick-hooks.ts — the three hooks that run inside the planner-tick step (autofill, the gap
 * harvester, the worktree reap) read back as plain facts. One pure function over the step's stored
 * report, shared by the run record (self-tick-last.ts) and `fleet self-tick --status`.
 *
 * A hook that did not run is 'skipped' with its reason, a hook that threw is 'failed' with the error,
 * and one whose numbers are missing is 'not-recorded'. None of them reads as a zero.
 */
export type SelfTickHookName = 'autofill' | 'gaps' | 'reap' | 'stranded-requeue';

/** items = what the hook produced (jobs applied, gap jobs queued, worktrees removed); null unless it ran. */
export interface SelfTickHook {
  hook: SelfTickHookName;
  state: 'ran' | 'skipped' | 'failed' | 'not-recorded';
  items: number | null;
  count: number | null;
  note: string | null;
}

const rec = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown): string | null => typeof v === 'string' ? v.slice(0, 200) : null;
const missing = (hook: SelfTickHookName): SelfTickHook => ({ hook, state: 'not-recorded', items: null, count: null, note: null });
const skipped = (hook: SelfTickHookName, reason: unknown): SelfTickHook => ({ hook, state: 'skipped', items: null, count: null, note: text(reason) });
const failed = (hook: SelfTickHookName, error: unknown): SelfTickHook => ({ hook, state: 'failed', items: null, count: null, note: text(error) ?? 'unknown error' });

/** The three hooks out of the planner-tick step's stored report, for a run in the given mode. */
export function hooksFromPlannerReport(planner: unknown, mode: 'apply' | 'dry-run' = 'apply'): SelfTickHook[] {
  const row = rec(planner);
  if (!row) return [missing('autofill'), missing('gaps'), missing('reap'), missing('stranded-requeue')];

  const auto = rec(row['autofill']);
  let autofill = missing('autofill');
  let gaps = missing('gaps');
  if (auto) {
    if (typeof auto['error'] === 'string') {
      autofill = failed('autofill', auto['error']);
      gaps = skipped('gaps', 'autofill failed before the gap harvest');
    } else if (Array.isArray(auto['runs'])) {
      const runs = auto['runs'] as unknown[];
      if (mode === 'dry-run') {
        const drafted = runs.reduce<number>((sum, r) => sum + (num(rec(r)?.['drafted']) ?? 0), 0);
        autofill = skipped('autofill', `dry run: would draft ${drafted} ${drafted === 1 ? 'job' : 'jobs'}, queued none`);
        gaps = skipped('gaps', 'dry run: the gap harvest only runs with apply');
      } else {
        const applied = runs.reduce<number>((sum, r) => sum + (num(rec(r)?.['applied']) ?? 0), 0);
        autofill = { hook: 'autofill', state: 'ran', items: applied, count: null, note: text(auto['reason']) };
        const g = rec(auto['gaps']);
        gaps = g && num(g['queued']) !== null && num(g['candidates']) !== null
          ? { hook: 'gaps', state: 'ran', items: num(g['queued']), count: num(g['candidates']), note: text(auto['gapsNote']) ?? (g['unknown'] === true ? 'some sources unknown' : null) }
          : skipped('gaps', text(auto['gapsNote']) ?? 'no gap note in this report (older build)');
      }
    } else { autofill = skipped('autofill', auto['reason']); gaps = skipped('gaps', text(auto['reason']) ?? 'autofill did not run'); }
  }

  const reapRow = rec(row['worktreeReap']);
  let reap = missing('reap');
  if (reapRow) {
    const state = reapRow['state'];
    const last = rec(reapRow['last']);
    if (typeof reapRow['error'] === 'string') reap = failed('reap', reapRow['error']);
    else if (state === 'ran' && num(last?.['removed']) !== null) reap = { hook: 'reap', state: 'ran', items: num(last?.['removed']), count: null, note: null };
    else if (state === 'dry-run') reap = skipped('reap', 'dry run: nothing removed');
    else if (state === 'skipped') reap = skipped('reap', reapRow['reason']);
  }
  // The line is "requeued=N gave_up=N already=N"; items is what was requeued.
  const sr = rec(row['strandedRequeue']);
  let stranded = missing('stranded-requeue');
  if (sr) {
    if (typeof sr['error'] === 'string') stranded = failed('stranded-requeue', sr['error']);
    else if (typeof sr['reason'] === 'string') stranded = skipped('stranded-requeue', sr['reason']);
    else if (Array.isArray(sr['requeued'])) {
      stranded = mode === 'dry-run' ? skipped('stranded-requeue', text(sr['summary']) ?? 'dry run')
        : { hook: 'stranded-requeue', state: 'ran', items: (sr['requeued'] as unknown[]).length, count: null, note: text(sr['summary']) };
    }
  }
  return [autofill, gaps, reap, stranded];
}
