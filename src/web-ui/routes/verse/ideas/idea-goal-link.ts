import type { GoalSummary } from '../../../data/queries.js';
import type { IdeaRow } from './ideas-model.js';

export function ideaGoalId(idea: IdeaRow): string | null {
  return idea.goal?.id || null;
}

export function goalChipText(goalId: string | null, goals: readonly GoalSummary[]): string | null {
  if (!goalId) return null;
  const objective = goals.find(goal => goal.id === goalId)?.objective;
  return `for: ${objective ? objective.slice(0, 60) : `goal ${goalId}`}`;
}

export function filterIdeasByGoal(ideas: readonly IdeaRow[], goalId: string | 'all'): IdeaRow[] {
  return goalId === 'all' ? [...ideas] : ideas.filter(idea => ideaGoalId(idea) === goalId);
}
