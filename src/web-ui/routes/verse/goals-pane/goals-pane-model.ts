/**
 * routes/verse/goals-pane/goals-pane-model.ts: pure shaping for the Goals
 * pane. Open goals only (done and archived are history), ordered by how much
 * they need looking at, with the one-percent rule applied to progress.
 */
import { formatProductDisplayText } from '../../../../core/vision/leader-display-text.js';
import type { GoalSummary } from '../../../data/queries.js';
import { usedPercentText } from '../percent-text.js';

export interface GoalLine {
  id: string;
  objective: string;
  status: string;
  percentText: string;
  /** 0-100 for the bar, or null when the goal reports no progress. */
  percent: number | null;
  nextMilestone: string | null;
  milestoneCounts: string;
}

const STATUS_RANK: Record<string, number> = { active: 0, planning: 1, paused: 2 };
const rank = (status: string): number => STATUS_RANK[status] ?? 3;

const fraction = (goal: GoalSummary): number | null => {
  const f = goal.progress?.fractionDone;
  return typeof f === 'number' && Number.isFinite(f) ? f : null;
};

/** Goals still in play: active first, then planning, then paused, then furthest along. */
export function openGoals(goals: readonly GoalSummary[]): GoalSummary[] {
  return goals
    .filter(g => g.status !== 'done' && g.status !== 'archived')
    .sort((a, b) => rank(a.status) - rank(b.status) || (fraction(b) ?? -1) - (fraction(a) ?? -1));
}

export function goalLine(goal: GoalSummary): GoalLine {
  const f = fraction(goal);
  const milestones = goal.milestones ?? [];
  const next = milestones
    .filter(m => m.status !== 'done')
    .sort((a, b) => a.order - b.order)[0];
  const done = milestones.filter(m => m.status === 'done').length;
  return {
    id: goal.id,
    objective: formatProductDisplayText(goal.objective),
    status: goal.status,
    percentText: f === null ? 'unknown' : usedPercentText(f * 100),
    percent: f === null ? null : Math.max(0, Math.min(100, Math.floor(f * 100))),
    nextMilestone: next ? formatProductDisplayText(next.title) : null,
    milestoneCounts: `${done} of ${milestones.length} done`,
  };
}

/** "4 active · 1 paused · 2 planning", or "No open goals". */
export function goalsHeadline(goals: readonly GoalSummary[]): string {
  const open = openGoals(goals);
  if (open.length === 0) return 'No open goals';
  const count = (s: string) => open.filter(g => g.status === s).length;
  return `${count('active')} active · ${count('paused')} paused · ${count('planning')} planning`;
}
