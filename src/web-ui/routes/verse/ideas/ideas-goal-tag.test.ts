import { expect, it } from 'vitest';
import type { GoalSummary } from '../../../data/queries.js';
import { tagIdeas } from './ideas-goal-tag.js';

it('links explicit references and stably orders linked ideas ahead of unlinked ideas', () => {
  const goals = [{ id: 'g1', objective: 'Ship releases' }, { id: 'g2', objective: 'Improve tests', slug: 'test-work' }] as GoalSummary[];
  const ideas = [{ title: 'Other' }, { title: 'Use g1 now' }, { title: 'test-work' },
    { title: 'g10 is different' }, { title: 'g1', goalId: 'missing' }, { title: 'field', goal_id: 'g2' }];
  const rows = tagIdeas(ideas, goals);
  expect(rows.map(row => row.idea.title)).toEqual(['Use g1 now', 'test-work', 'field', 'Other', 'g10 is different', 'g1']);
  expect(rows.map(row => row.goal?.id ?? null)).toEqual(['g1', 'g2', 'g2', null, null, null]);
});
