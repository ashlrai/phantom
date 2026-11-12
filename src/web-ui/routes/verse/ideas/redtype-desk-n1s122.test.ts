import { expect, it } from 'vitest';
import type { GoalSummary } from '../../../data/queries.js';
import { tagIdeas } from './ideas-goal-tag.js';

it('matches complete goal identifiers and keeps explicit unknown references unlinked', () => {
  const goals = [{ id: 'goal-1', objective: 'Example goal' }] as GoalSummary[];
  const ideas = [{ title: 'goal-10' }, { title: 'GOAL-1' }, { title: 'goal-1', goalId: 'missing' }];

  expect(tagIdeas(ideas, goals).map(({ goal }) => goal?.id ?? null)).toEqual(['goal-1', null, null]);
});
