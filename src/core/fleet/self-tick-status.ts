/**
 * self-tick-status.ts — `phm fleet self-tick --status`: when did the self-tick last run, and what did its
 * hooks (autofill, gaps, reap) produce? Reads only the record the tick itself wrote
 * (queue/self-tick-last.json) and never runs a step or takes the lock. The hooks run inside the
 * planner-tick step, so their counts come from that step's stored report.
 *
 * No record reads "no self-tick run recorded"; a hook whose numbers are not in the record is "not recorded",
 * never zero.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSelfTickLast, SELF_TICK_LAST } from './self-tick-last.js';

export const SELF_TICK_STATUS_SCHEMA = 'fleet.self-tick-status.v1';
export type SelfTickHookName = 'autofill' | 'gaps' | 'reap';

/**
 * items = what the hook produced (lanes' jobs applied, gap jobs queued, worktrees removed); null when not recorded.
 * count = the gap hook's candidate count (gap jobs it looked at, queued or not); null for the other hooks and when not run.
 */
export interface SelfTickHook { hook: SelfTickHookName; state: 'ran' | 'skipped' | 'not-recorded'; items: number | null; count: number | null; note: string | null }

export type SelfTickStatus =
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'none'; line: string }
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'unreadable'; line: string }
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'recorded'; at: string; ageSeconds: number; mode: 'apply' | 'dry-run'; failedSteps: string[]; hooks: SelfTickHook[]; line: string };

const rec = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const missing = (hook: SelfTickHookName): SelfTickHook => ({ hook, state: 'not-recorded', items: null, count: null, note: null });
const skipped = (hook: SelfTickHookName, reason: unknown): SelfTickHook =>
  ({ hook, state: 'skipped', items: null, count: null, note: typeof reason === 'string' ? reason.slice(0, 120) : null });

/** The gap hook out of the autofill record's `gaps` field; anything short of both numbers is skipped with the reason. */
function gapsHook(record: unknown, notRunReason: string): SelfTickHook {
  const g = rec(record);
  const candidates = num(g?.['candidates']);
  const queued = num(g?.['queued']);
  if (!g || candidates === null || queued === null) return skipped('gaps', notRunReason);
  return { hook: 'gaps', state: 'ran', items: queued, count: candidates, note: g['unknown'] === true ? 'some sources unknown' : null };
}

/** Pure: the three hooks out of the planner-tick step's stored report. */
export function hooksFromPlannerReport(planner: unknown): SelfTickHook[] {
  const row = rec(planner);
  if (!row) return [missing('autofill'), missing('gaps'), missing('reap')];

  // The gap hook runs inside autofill, so when autofill did not run the gap hook did not run either.
  const auto = rec(row['autofill']);
  let autofill = missing('autofill');
  let gaps = missing('gaps');
  if (auto) {
    if (Array.isArray(auto['runs'])) {
      const applied = (auto['runs'] as unknown[]).reduce<number>((sum, r) => sum + (num(rec(r)?.['applied']) ?? 0), 0);
      autofill = { hook: 'autofill', state: 'ran', items: applied, count: null, note: typeof auto['reason'] === 'string' ? auto['reason'] : null };
      gaps = gapsHook(auto['gaps'], 'the gap hook did not run');
    } else {
      autofill = skipped('autofill', auto['reason']);
      gaps = gapsHook(null, typeof auto['reason'] === 'string' ? auto['reason'] : 'autofill did not run');
    }
  }

  const reapRow = rec(row['worktreeReap']);
  let reap = missing('reap');
  if (reapRow) {
    const state = reapRow['state'];
    const last = rec(reapRow['last']);
    if (state === 'ran' && num(last?.['removed']) !== null) reap = { hook: 'reap', state: 'ran', items: num(last?.['removed']), count: null, note: null };
    else if (state === 'dry-run') reap = skipped('reap', 'dry run: nothing removed');
    else if (state === 'skipped') reap = skipped('reap', reapRow['reason']);
  }
  return [autofill, gaps, reap];
}

export function readSelfTickStatus(runsDir: string, now: number): SelfTickStatus {
  const view = readSelfTickLast(runsDir, now);
  if (view === null) return { schema: SELF_TICK_STATUS_SCHEMA, state: 'none', line: 'no self-tick run recorded' };
  if (view.state === 'unreadable') return { schema: SELF_TICK_STATUS_SCHEMA, state: 'unreadable', line: 'self-tick record unreadable' };
  // The record just validated; read it once more for the planner step's stored report.
  let planner: unknown = null;
  try {
    const steps = rec(JSON.parse(readFileSync(join(runsDir, SELF_TICK_LAST), 'utf8')))?.['steps'];
    if (Array.isArray(steps)) planner = (steps as unknown[]).map(rec).find(s => s?.['step'] === 'planner-tick')?.['report'] ?? null;
  } catch { /* hooks read as not recorded */ }
  const hooks = view.ranState === 'busy' ? [missing('autofill'), missing('gaps'), missing('reap')] : hooksFromPlannerReport(planner);
  return {
    schema: SELF_TICK_STATUS_SCHEMA, state: 'recorded', at: view.at, ageSeconds: view.ageSeconds, mode: view.mode,
    failedSteps: view.failedSteps, hooks, line: selfTickStatusLine(view.at, view.ageSeconds, view.mode, hooks),
  };
}

const ago = (s: number): string => s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
/** The gap hook's human line: a zero is said as zero candidates; a hook that did not run says why. */
export function gapsHookLine(h: SelfTickHook): string {
  if (h.state === 'not-recorded') return 'gaps: not recorded';
  if (h.state === 'skipped') return `gaps: skipped (${h.note ?? 'no reason recorded'})`;
  const unknown = h.note !== null ? ` (${h.note})` : '';
  if (h.count === 0) return h.note === null ? 'gaps: 0 candidates (no Remaining gaps found)' : `gaps: 0 candidates${unknown}`;
  return `gaps: ${h.count} ${h.count === 1 ? 'candidate' : 'candidates'}, ${h.items} queued${unknown}`;
}

const hookText = (h: SelfTickHook): string => h.hook === 'gaps' ? gapsHookLine(h) :
  `${h.hook} ${h.state === 'ran' ? `${h.items} ${h.items === 1 ? 'item' : 'items'}` : h.state === 'skipped' ? `skipped${h.note ? ` (${h.note})` : ''}` : 'not recorded'}`;

function selfTickStatusLine(at: string, ageSeconds: number, mode: string, hooks: SelfTickHook[]): string {
  return `self-tick last ran ${at} (${ago(ageSeconds)}, ${mode}); ${hooks.map(hookText).join(', ')}`;
}

/** Plain words, one line per fact. */
export function selfTickStatusLines(s: SelfTickStatus): string[] {
  if (s.state !== 'recorded') return [s.line];
  return [`self-tick last ran ${s.at} (${ago(s.ageSeconds)}, ${s.mode})`, ...s.hooks.map(h => `  ${hookText(h)}`)];
}
