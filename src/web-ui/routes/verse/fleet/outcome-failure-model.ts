import type { OutcomeView } from './outcomes-types.js';

type OutcomeTaskView = OutcomeView['tasks'][number];

const MAX_LISTED = 5;

export interface OutcomeFailureView {
  headline: string;
  failedTasks: Array<{ id: string; title: string; repo: string | null; state: 'failed' | 'aborted'; runId: string | null }>;
  /** Failed tasks beyond the listed ones. */
  moreFailed: number;
  nextStep: string;
  /**
   * Always null today: the outcomes API has no retry action, and `resume` only
   * clears a pause, which is a no-op for an outcome that is already failed.
   */
  action: null;
}

const isFailed = (task: OutcomeTaskView): task is OutcomeTaskView & { state: 'failed' | 'aborted' } =>
  task.state === 'failed' || task.state === 'aborted';

/** Facts only: what failed and the one next step those facts support. */
export function describeOutcomeFailure(outcome: OutcomeView): OutcomeFailureView {
  const failed = outcome.tasks.filter(isFailed);
  const managerFailed = outcome.manager?.latest?.state === 'failed';
  const headline = failed.length ? `${failed.length} of ${outcome.tasks.length} tasks failed`
    : managerFailed ? 'Manager stage failed' : 'Failed, no failed task recorded';
  const nextStep = failed.some(task => task.runId) ? 'Open the run log to see the error, then retry.'
    : managerFailed ? 'Retry planning.' : 'Retry to re-plan from the current master.';
  return {
    headline, nextStep, action: null, moreFailed: Math.max(0, failed.length - MAX_LISTED),
    failedTasks: failed.slice(0, MAX_LISTED).map(task => ({ id: task.id, title: task.title, repo: task.repo, state: task.state, runId: task.runId })),
  };
}
