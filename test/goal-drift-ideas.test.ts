import { describe, expect, it } from 'vitest';
import { planGoalDriftIdeas, type DriftGoal } from '../src/core/fleet/goal-drift-ideas.js';
import type { GoalMetric } from '../src/core/fleet/goal-metrics.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const metric = (over: Partial<GoalMetric> = {}): GoalMetric =>
  ({ metric: 'merges-per-hour', value: 2, unit: '/h', delta24h: -3, observedAt: NOW, state: 'live', ...over });
const goal = (id: string, m: GoalMetric, target: number | null = 5): DriftGoal => ({ id, objective: `Goal ${id}`, metric: m, target });

describe('planGoalDriftIdeas', () => {
  it('turns a behind, worsening goal into one linked idea', () => {
    const ideas = planGoalDriftIdeas([goal('g1', metric())], [], NOW);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({ source: 'goal-drift', goalId: 'g1', goalName: 'Goal g1' });
    expect(ideas[0]!.title).toBe('Goal Goal g1 is off track: merges-per-hour is 2/h against 5/h target; propose work on it');
  });
  it('gives none when behind but improving', () => {
    expect(planGoalDriftIdeas([goal('g1', metric({ delta24h: 1 }))], [], NOW)).toEqual([]);
  });
  it('gives none with no reading, a stale reading or an unknown trend', () => {
    const unknown = metric({ value: null, delta24h: null, state: 'unknown' });
    expect(planGoalDriftIdeas([goal('g1', unknown), goal('g2', metric({ state: 'stale' })), goal('g3', metric({ delta24h: null }))], [], NOW)).toEqual([]);
  });
  it('gives none while an open idea links the same goal', () => {
    expect(planGoalDriftIdeas([goal('g1', metric())], [{ goalId: 'g1' }], NOW)).toEqual([]);
  });
  it('gives two ideas with distinct goal links for two off-track goals', () => {
    const ideas = planGoalDriftIdeas([goal('g1', metric()), goal('g2', metric())], [], NOW);
    expect(ideas.map(i => i.goalId)).toEqual(['g1', 'g2']);
    expect(new Set(ideas.map(i => i.id)).size).toBe(2);
  });
  it('reads lower-is-better metrics and goals without a target', () => {
    const dirty = metric({ metric: 'open-dirty-prs', value: 9, unit: ' PRs', delta24h: 4 });
    const [idea] = planGoalDriftIdeas([goal('g1', dirty, null)], [], NOW);
    expect(idea!.title).toContain('open-dirty-prs is 9 PRs against 5 PRs a day ago');
    expect(planGoalDriftIdeas([goal('g1', metric({ delta24h: 0 }), null)], [], NOW)).toEqual([]);
  });
});
