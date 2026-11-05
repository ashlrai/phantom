import { describe, expect, it } from 'vitest';
import { describeOutcomeFailure } from './outcome-failure-model.js';
import type { OutcomeView } from './outcomes-types.js';

type Task = OutcomeView['tasks'][number];
const task = (n: number, state: Task['state'], runId: string | null = `run-${n}`): Task =>
  ({ id: `task-${n}`, key: `k${n}`, title: `Task ${n}`, repo: '/repo/a', state, runId, controllerRunId: null, proposalId: null, mergeIdentity: null });
const outcome = (tasks: Task[], manager?: OutcomeView['manager']): OutcomeView => ({
  id: 'outcome-x', revision: 1, scopeRevision: 1, status: 'failed', tasks, ...(manager ? { manager } : {}),
  scope: { desiredOutcome: 'Improve', targetRepos: ['/repo/a'], acceptance: ['Done'] },
});
const failedManager = (): NonNullable<OutcomeView['manager']> => ({
  sourceState: 'healthy', enabled: true, mode: 'resident', sessionId: null, conversationRevision: 0, running: null, next: null,
  latest: { state: 'failed' } as never,
});

describe('describeOutcomeFailure', () => {
  it('counts failed and aborted tasks against all tasks', () => {
    const view = describeOutcomeFailure(outcome([task(1, 'failed'), task(2, 'aborted'), task(3, 'complete'), task(4, 'pending'), task(5, 'running')]));
    expect(view.headline).toBe('2 of 5 tasks failed');
    expect(view.failedTasks.map(t => t.title)).toEqual(['Task 1', 'Task 2']);
    expect(view.nextStep).toBe('Open the run log to see the error, then retry.');
  });
  it('names the manager stage when no task failed', () => {
    const view = describeOutcomeFailure(outcome([task(1, 'pending')], failedManager()));
    expect(view.headline).toBe('Manager stage failed');
    expect(view.nextStep).toBe('Retry planning.');
    expect(view.failedTasks).toEqual([]);
  });
  it('admits when nothing was recorded', () => {
    const view = describeOutcomeFailure(outcome([]));
    expect(view.headline).toBe('Failed, no failed task recorded');
    expect(view.nextStep).toBe('Retry to re-plan from the current master.');
  });
  it('lists at most five failed tasks and counts the rest', () => {
    const view = describeOutcomeFailure(outcome(Array.from({ length: 7 }, (_, i) => task(i + 1, 'failed'))));
    expect(view.headline).toBe('7 of 7 tasks failed');
    expect(view.failedTasks).toHaveLength(5);
    expect(view.moreFailed).toBe(2);
  });
  it('offers no action because the API has no retry for a failed outcome', () => {
    expect(describeOutcomeFailure(outcome([task(1, 'failed')])).action).toBeNull();
    expect(describeOutcomeFailure(outcome([])).action).toBeNull();
  });
  it('does not point at a run log when the failed task has no run', () => {
    expect(describeOutcomeFailure(outcome([task(1, 'failed', null)])).nextStep).toBe('Retry to re-plan from the current master.');
  });
});
