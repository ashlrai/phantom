import { describe, expect, it } from 'vitest';
import type { GoalSummary } from '../../../data/queries.js';
import { rankIdeas } from './ideas-model.js';
import { filterIdeasByGoal, goalChipText, ideaGoalId } from './idea-goal-link.js';

const rows = rankIdeas([
  { id: 'one', title: 'One', source: 'goal-drift', goalId: 'g1' },
  { id: 'two', title: 'Two', source: 'issue' },
]);
const goals = [{ id: 'g1', objective: 'x'.repeat(70) }] as GoalSummary[];

describe('idea goal links', () => {
  it('extracts goal IDs and handles unlinked ideas', () => {
    expect(ideaGoalId(rows[0]!)).toBe('g1');
    expect(ideaGoalId(rows[1]!)).toBeNull();
  });
  it('caps objectives and falls back for unknown goals', () => {
    expect(goalChipText('g1', goals)).toBe(`for: ${'x'.repeat(60)}`);
    expect(goalChipText('missing', goals)).toBe('for: goal missing');
    expect(goalChipText(null, goals)).toBeNull();
  });
  it('filters by goal or keeps all ideas', () => {
    expect(filterIdeasByGoal(rows, 'all')).toEqual(rows);
    expect(filterIdeasByGoal(rows, 'g1')).toEqual([rows[0]]);
  });
});
