import { describe, expect, it } from 'vitest';
import {
  explainOutcome,
  type ExplainOutcomeDeps,
  type OutcomeTaskView,
  type OutcomeView,
  type OutcomesRead,
} from '../src/core/fleet/outcome-why.js';

function task(state: OutcomeTaskView['state'], runId: string | null = null, key = 'task'): OutcomeTaskView {
  return {
    id: `public-${key}`, key, title: `${key} title`, repo: 'ashlrai/phantom',
    state, runId, controllerRunId: runId, proposalId: null, mergeIdentity: null,
  };
}

function view(over: Partial<OutcomeView> = {}): OutcomeView {
  return {
    id: 'continuously-improve-phantom',
    revision: 3,
    scopeRevision: 1,
    scope: { desiredOutcome: 'Continuously improve Phantom', targetRepos: ['ashlrai/phantom'], acceptance: [] },
    status: 'failed',
    tasks: [task('complete', null, 'scaffold')],
    ...over,
  };
}

function read(outcomes: OutcomeView[] | null): OutcomesRead {
  return outcomes === null
    ? { v: 1, sourceState: 'degraded', outcomes: null, enrollment: { sourceState: 'degraded', repos: null } }
    : { v: 1, sourceState: 'healthy', outcomes, enrollment: { sourceState: 'healthy', repos: ['ashlrai/phantom'] } };
}

function deps(body: OutcomesRead | Error, existingLogs: string[] = []): ExplainOutcomeDeps {
  return {
    run: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
    logPathFor: runId => `/home/test/.ashlr/run-streams/${runId}.log`,
    fileExists: path => existingLogs.includes(path),
  };
}

describe('fleet outcome-why explainOutcome', () => {
  it('reports headline, both failed tasks and the one existing log', async () => {
    const outcome = view({
      tasks: [
        task('failed', 'run-aaa', 'fix-flaky-test'),
        task('aborted', 'run-bbb', 'recut-docs'),
        task('complete', null, 'scaffold'),
      ],
    });
    const result = await explainOutcome(outcome.id, deps(read([outcome]), ['/home/test/.ashlr/run-streams/run-aaa.log']));
    expect(result).toMatchObject({ v: 1, id: outcome.id, status: 'failed', headline: '2 of 3 tasks failed' });
    if ('error' in result || 'outcomes' in result) throw new Error('expected a single explanation');
    expect(result.failedTasks).toHaveLength(2);
    expect(result.failedTasks.map(t => [t.key, t.state, t.runId])).toEqual([
      ['fix-flaky-test', 'failed', 'run-aaa'],
      ['recut-docs', 'aborted', 'run-bbb'],
    ]);
    expect(result.failedTasks[0]!.logPath).toBe('/home/test/.ashlr/run-streams/run-aaa.log');
    expect(result.failedTasks[1]!.logPath).toBeNull();
    expect(result.nextStep).toContain('/home/test/.ashlr/run-streams/run-aaa.log');
  });

  it('returns not-found for an unknown id', async () => {
    const result = await explainOutcome('no-such-outcome', deps(read([view()])));
    expect(result).toEqual({ v: 1, id: 'no-such-outcome', error: 'not-found' });
  });

  it('reports source-unavailable when the ledger is degraded', async () => {
    const result = await explainOutcome('any-id', deps(read(null)));
    expect(result).toEqual({ v: 1, id: 'any-id', error: 'source-unavailable' });
  });

  it('reports source-unavailable when the read throws', async () => {
    const result = await explainOutcome(null, deps(new Error('worker dead')));
    expect(result).toEqual({ v: 1, id: null, error: 'source-unavailable' });
  });

  it('with no id explains every failed outcome and skips the rest', async () => {
    const failedA = view({ id: 'alpha' });
    const running = view({ id: 'beta', status: 'running', tasks: [task('running', 'run-ccc', 'work')] });
    const failedB = view({ id: 'gamma', tasks: [task('failed', null, 'broke')] });
    const result = await explainOutcome(undefined, deps(read([failedA, running, failedB])));
    if ('error' in result || !('outcomes' in result)) throw new Error('expected a list');
    expect(result.outcomes.map(outcome => outcome.id)).toEqual(['alpha', 'gamma']);
  });

  it('headlines a failed manager stage when no task failed', async () => {
    const outcome = view({
      status: 'failed',
      manager: { latest: { state: 'failed', runId: 'run-mgr', terminalRunId: 'run-mgr' } } as unknown as OutcomeView['manager'],
    });
    const result = await explainOutcome(outcome.id, deps(read([outcome])));
    if ('error' in result || 'outcomes' in result) throw new Error('expected a single explanation');
    expect(result.headline).toBe('Manager stage failed');
    expect(result.manager).toEqual({ latestState: 'failed' });
    expect(result.nextStep).toContain('run-mgr');
  });

  it('headlines "Failed, no failed task recorded" when nothing else explains the failure', async () => {
    const result = await explainOutcome('continuously-improve-phantom', deps(read([view()])));
    if ('error' in result || 'outcomes' in result) throw new Error('expected a single explanation');
    expect(result.headline).toBe('Failed, no failed task recorded');
    expect(result.failedTasks).toEqual([]);
    expect(result.manager).toEqual({ latestState: null });
  });

  it('still answers for a non-failed outcome', async () => {
    const running = view({ id: 'beta', status: 'running', tasks: [task('running', 'run-ccc', 'work')] });
    const result = await explainOutcome('beta', deps(read([running])));
    if ('error' in result || 'outcomes' in result) throw new Error('expected a single explanation');
    expect(result.status).toBe('running');
    expect(result.headline).toBe('No failure recorded');
  });
});
