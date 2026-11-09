import { describe, expect, it } from 'vitest';
import type { GoalSummary } from '../../../data/queries.js';
import { goalLine, goalsHeadline, openGoals } from './goals-pane-model.js';

function goal(id: string, status: string, fractionDone: number | null, milestones: GoalSummary['milestones'] = []): GoalSummary {
  const progress = fractionDone === null ? undefined : { fractionDone, counts: {}, nextActionableId: null };
  return { id, objective: `Objective ${id}`, status, milestones, progress } as GoalSummary;
}

describe('openGoals', () => {
  it('drops done and archived, orders by status then progress', () => {
    const out = openGoals([
      goal('p1', 'paused', 0.9), goal('d', 'done', 1), goal('a1', 'active', 0.2),
      goal('pl', 'planning', 0), goal('a2', 'active', 0.7), goal('x', 'archived', 0.5),
    ]);
    expect(out.map(g => g.id)).toEqual(['a2', 'a1', 'pl', 'p1']);
  });
});

describe('goalLine', () => {
  it('never shows 100% for 0.996', () => {
    expect(goalLine(goal('a', 'active', 0.996)).percentText).toBe('99%');
    expect(goalLine(goal('a', 'active', 0.996)).percent).toBe(99);
  });
  it('picks the lowest-order milestone that is not done and counts the done ones', () => {
    const line = goalLine(goal('a', 'active', 0.4, [
      { title: 'Third', status: 'pending', order: 3 },
      { title: 'First', status: 'done', order: 1 },
      { title: 'Second', status: 'pending', order: 2 },
    ]));
    expect(line.nextMilestone).toBe('Second');
    expect(line.milestoneCounts).toBe('1 of 3 done');
  });
  it('has no next milestone when all are done or none exist', () => {
    expect(goalLine(goal('a', 'active', 1, [{ title: 'Only', status: 'done', order: 1 }])).nextMilestone).toBeNull();
    expect(goalLine(goal('a', 'active', 0)).milestoneCounts).toBe('0 of 0 done');
  });
  it('reports unknown when progress is missing', () => {
    const line = goalLine(goal('a', 'active', null));
    expect(line.percentText).toBe('unknown');
    expect(line.percent).toBeNull();
  });
});

describe('goalsHeadline', () => {
  it('counts open goals by status', () => {
    const goals = [goal('1', 'active', 0), goal('2', 'active', 0), goal('3', 'paused', 0), goal('4', 'planning', 0), goal('5', 'done', 1)];
    expect(goalsHeadline(goals)).toBe('2 active · 1 paused · 1 planning');
  });
  it('says so when nothing is open', () => {
    expect(goalsHeadline([])).toBe('No open goals');
    expect(goalsHeadline([goal('1', 'done', 1)])).toBe('No open goals');
  });
});
