/**
 * Recut proof for RQ-PHX-RECUTN1R3300S92 (Recut of #3599 /
 * RQ-PHX-OUTCOMEWHYVERB24): asserts `explainOutcome` from the recut
 * src/core/fleet/outcome-why.ts produces the PR's flagship behavior — the
 * "N of M tasks failed" headline with per-task stream-log paths resolved
 * only for logs that exist on disk (the PR's own first test).
 */
import { describe, expect, it } from 'vitest';
import {
  explainOutcome,
  type ExplainOutcomeDeps,
  type OutcomeTaskView,
  type OutcomeView,
  type OutcomesRead,
} from '../src/core/fleet/outcome-why.js';

function task(state: OutcomeTaskView['state'], runId: string | null, key: string): OutcomeTaskView {
  return {
    id: `public-${key}`, key, title: `${key} title`, repo: 'ashlrai/phantom',
    state, runId, controllerRunId: runId, proposalId: null, mergeIdentity: null,
  };
}

const outcome: OutcomeView = {
  id: 'continuously-improve-phantom',
  revision: 3,
  scopeRevision: 1,
  scope: { desiredOutcome: 'Continuously improve Phantom', targetRepos: ['ashlrai/phantom'], acceptance: [] },
  status: 'failed',
  tasks: [
    task('failed', 'run-aaa', 'fix-flaky-test'),
    task('aborted', 'run-bbb', 'recut-docs'),
    task('complete', null, 'scaffold'),
  ],
};

const source: OutcomesRead = {
  v: 1, sourceState: 'healthy', outcomes: [outcome],
  enrollment: { sourceState: 'healthy', repos: ['ashlrai/phantom'] },
};

const deps: ExplainOutcomeDeps = {
  run: async () => source,
  logPathFor: runId => `/home/test/.ashlr/run-streams/${runId}.log`,
  fileExists: path => path === '/home/test/.ashlr/run-streams/run-aaa.log',
};

describe('recut n1r3300s92: fleet outcome-why is on the branch', () => {
  it('explains a failed outcome with failed tasks and existing log paths', async () => {
    const result = await explainOutcome(outcome.id, deps);
    expect(result).toMatchObject({ v: 1, id: outcome.id, status: 'failed', headline: '2 of 3 tasks failed' });
    if ('error' in result || 'outcomes' in result) throw new Error('expected a single explanation');
    expect(result.failedTasks.map(t => [t.key, t.state, t.runId])).toEqual([
      ['fix-flaky-test', 'failed', 'run-aaa'],
      ['recut-docs', 'aborted', 'run-bbb'],
    ]);
    expect(result.failedTasks[0]!.logPath).toBe('/home/test/.ashlr/run-streams/run-aaa.log');
    expect(result.failedTasks[1]!.logPath).toBeNull();
    expect(result.nextStep).toContain('/home/test/.ashlr/run-streams/run-aaa.log');
  });
});
