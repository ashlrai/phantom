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
import { hooksFromPlannerReport, type SelfTickHook, type SelfTickHookName } from './self-tick-hooks.js';
import { readSelfTickLast, SELF_TICK_LAST } from './self-tick-last.js';

export const SELF_TICK_STATUS_SCHEMA = 'fleet.self-tick-status.v1';
export type { SelfTickHook, SelfTickHookName };

export type SelfTickStatus =
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'none'; line: string }
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'unreadable'; line: string }
  | { schema: typeof SELF_TICK_STATUS_SCHEMA; state: 'recorded'; at: string; ageSeconds: number; mode: 'apply' | 'dry-run'; failedSteps: string[]; hooks: SelfTickHook[]; line: string };

const rec = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const missing = (hook: SelfTickHookName): SelfTickHook => ({ hook, state: 'not-recorded', items: null, count: null, note: null });

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
  const hooks = view.ranState === 'busy' ? [missing('autofill'), missing('gaps'), missing('reap')] : hooksFromPlannerReport(planner, view.mode);
  return {
    schema: SELF_TICK_STATUS_SCHEMA, state: 'recorded', at: view.at, ageSeconds: view.ageSeconds, mode: view.mode,
    failedSteps: view.failedSteps, hooks, line: selfTickStatusLine(view.at, view.ageSeconds, view.mode, hooks),
  };
}

const ago = (s: number): string => s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
/** The gap hook's human line: a zero is said as zero candidates; a hook that did not run says why. */
export function gapsHookLine(h: SelfTickHook): string {
  if (h.state === 'not-recorded') return 'gaps: not recorded';
  if (h.state === 'failed') return `gaps: failed (${h.note ?? 'unknown error'})`;
  if (h.state === 'skipped') return `gaps: skipped (${h.note ?? 'no reason recorded'})`;
  const unknown = h.note !== null ? ` (${h.note})` : '';
  if (h.count === 0) return h.note === null ? 'gaps: 0 candidates (no Remaining gaps found)' : `gaps: 0 candidates${unknown}`;
  return `gaps: ${h.count} ${h.count === 1 ? 'candidate' : 'candidates'}, ${h.items} queued${unknown}`;
}

const hookText = (h: SelfTickHook): string => h.hook === 'gaps' ? gapsHookLine(h) :
  `${h.hook} ${h.state === 'ran' ? `${h.items} ${h.items === 1 ? 'item' : 'items'}` : h.state === 'skipped' ? `skipped${h.note ? ` (${h.note})` : ''}` : h.state === 'failed' ? `failed (${h.note})` : 'not recorded'}`;

function selfTickStatusLine(at: string, ageSeconds: number, mode: string, hooks: SelfTickHook[]): string {
  return `self-tick last ran ${at} (${ago(ageSeconds)}, ${mode}); ${hooks.map(hookText).join(', ')}`;
}

/** Plain words, one line per fact. */
export function selfTickStatusLines(s: SelfTickStatus): string[] {
  if (s.state !== 'recorded') return [s.line];
  return [`self-tick last ran ${s.at} (${ago(s.ageSeconds)}, ${s.mode})`, ...s.hooks.map(h => `  ${hookText(h)}`)];
}
