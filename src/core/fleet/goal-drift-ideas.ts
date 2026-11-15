/**
 * core/fleet/goal-drift-ideas.ts: turn a goal that is falling off track into
 * one Idea. Pure: callers pass the bound goal metrics and the ideas still
 * open, and write the result through the existing ideas writer. Unknown data
 * never produces an idea.
 */
import type { GoalMetric, GoalMetricId } from './goal-metrics.js';

export const GOAL_DRIFT_SOURCE = 'goal-drift';

export interface DriftGoal {
  id: string;
  objective: string;
  metric: GoalMetric;
  /** Optional numeric target in the metric's unit; without one only a worsening trend counts. */
  target?: number | null;
}

export interface OpenIdea { goalId?: string | null }

export interface GoalDriftIdea {
  id: string;
  source: typeof GOAL_DRIFT_SOURCE;
  goalId: string;
  goalName: string;
  title: string;
  detail: string;
  ts: string;
}

/** +1 when a higher reading is better, -1 when lower is. */
const BETTER: Record<GoalMetricId, 1 | -1> = { 'merges-per-hour': 1, 'open-dirty-prs': -1 };

const num = (n: number): string => String(Math.round(n * 100) / 100);

export function planGoalDriftIdeas(goals: readonly DriftGoal[], openIdeas: readonly OpenIdea[], now: number): GoalDriftIdea[] {
  const covered = new Set(openIdeas.map(i => i.goalId).filter((id): id is string => typeof id === 'string'));
  const out: GoalDriftIdea[] = [];
  for (const goal of goals) {
    const m = goal.metric;
    if (covered.has(goal.id) || m.metric === null || m.state !== 'live' || m.value === null || m.delta24h === null) continue;
    // Positive `trend` means the metric moved the right way over 24h.
    const trend = m.delta24h * BETTER[m.metric];
    const target = typeof goal.target === 'number' && Number.isFinite(goal.target) ? goal.target : null;
    const behind = target !== null && (m.value - target) * BETTER[m.metric] < 0;
    if (!(target !== null ? behind && trend <= 0 : trend < 0)) continue;
    const against = target !== null ? `${num(target)}${m.unit} target` : `${num(m.value - m.delta24h)}${m.unit} a day ago`;
    const name = goal.objective;
    covered.add(goal.id);
    out.push({
      id: `${GOAL_DRIFT_SOURCE}:${goal.id}`,
      source: GOAL_DRIFT_SOURCE,
      goalId: goal.id,
      goalName: name,
      title: `Goal ${name} is off track: ${m.metric} is ${num(m.value)}${m.unit} against ${against}; propose work on it`,
      detail: `Metric ${m.metric} moved ${num(m.delta24h)}${m.unit} in 24h.`,
      ts: new Date(now).toISOString(),
    });
  }
  return out;
}
