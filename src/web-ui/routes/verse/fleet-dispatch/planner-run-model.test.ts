import { describe, expect, it } from 'vitest';
import type { PlannerPlanView } from './planner-plan-queries.js';
import { plannerRunLine, runButtonState } from './planner-run-model.js';
import type { PlannerRunRecord } from './planner-run-store.js';

const start = Date.parse('2026-11-01T11:41:00Z');
const finish = Date.parse('2026-11-01T11:58:00Z');
const empty: PlannerRunRecord = { startedAt: null, finishedAt: null, ok: null, text: null, needsSlate: false };
const running = { ...empty, startedAt: start };
const done = { ...running, finishedAt: finish, ok: true, text: 'Planner pass ran on codex-personal: ran (exit 0)' };
const plan = { source: 'ok' } as PlannerPlanView;

describe('planner run presentation', () => {
  it('shows no line before a run and the start time while running', () => {
    expect(plannerRunLine(empty, finish)).toBeNull();
    expect(plannerRunLine(running, finish)).toEqual({ text: 'Planner pass running since 06:41 (up to 20 min)', tone: 'warn' });
  });
  it('shows the finished result and distinguishes errors and missing slate', () => {
    expect(plannerRunLine(done, finish)).toEqual({ text: 'Last pass 06:58: ran on codex-personal (exit 0)', tone: 'ok' });
    expect(plannerRunLine({ ...done, ok: false, text: 'A planner pass is already running' }, finish)).toEqual({ text: 'Last pass 06:58: A planner pass is already running', tone: 'bad' });
    expect(plannerRunLine({ ...done, ok: false, text: null }, finish)).toEqual({ text: 'Last pass 06:58: The request failed.', tone: 'bad' });
    expect(plannerRunLine({ ...done, ok: false, needsSlate: true }, finish)).toEqual({ text: 'No planner slate declared: declare logins in Settings', tone: 'warn' });
  });
  it('disables the button during a run or without an available plan', () => {
    expect(runButtonState(empty, plan)).toEqual({ disabled: false, label: 'Run planner pass' });
    expect(runButtonState(done, plan).disabled).toBe(false);
    expect(runButtonState(running, plan).disabled).toBe(true);
    for (const source of ['missing', 'invalid', 'unavailable'] as const) expect(runButtonState(empty, { ...plan, source }).disabled).toBe(true);
    expect(runButtonState(empty, null).disabled).toBe(true);
    expect(runButtonState(empty, undefined).disabled).toBe(true);
  });
});
