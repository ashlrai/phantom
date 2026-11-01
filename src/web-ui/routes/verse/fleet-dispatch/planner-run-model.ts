import type { PlannerLine } from './planner-plan-model.js';
import type { PlannerPlanView } from './planner-plan-queries.js';
import type { PlannerRunRecord } from './planner-run-store.js';

const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function plannerRunLine(record: PlannerRunRecord, _nowMs: number): PlannerLine | null {
  if (record.startedAt === null) return null;
  if (record.finishedAt === null) return { text: `Planner pass running since ${clock.format(record.startedAt)} (up to 20 min)`, tone: 'warn' };
  if (record.needsSlate) return { text: 'No planner slate declared: declare logins in Settings', tone: 'warn' };
  const detail = (record.text ?? 'The request failed.').replace(/^Planner pass ran on (.*): ran \(exit 0\)$/, 'ran on $1 (exit 0)');
  return { text: `Last pass ${clock.format(record.finishedAt)}: ${detail}`, tone: record.ok ? 'ok' : 'bad' };
}

export function runButtonState(record: PlannerRunRecord, plan: PlannerPlanView | null | undefined): { disabled: boolean; label: string } {
  return { disabled: (record.startedAt !== null && record.finishedAt === null) || plan?.source !== 'ok', label: 'Run planner pass' };
}
