import { describe, expect, it } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
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
    tasks: [task('failed', 'run-aaa', 'fix-flaky-test'), task('complete', null, 'scaffold')],
    ...over,
  };
}

function read(outcomes: OutcomeView[] | null): OutcomesRead {
  return outcomes === null
    ? { v: 1, sourceState: 'degraded', outcomes: null, enrollment: { sourceState: 'degraded', repos: null } }
    : { v: 1, sourceState: 'healthy', outcomes, enrollment: { sourceState: 'healthy', repos: ['ashlrai/phantom'] } };
}

function deps(outcomes: OutcomeView[] | null, existingLogs: string[] = []): ExplainOutcomeDeps {
  return {
    run: async () => read(outcomes),
    logPathFor: runId => `/home/test/.ashlr/run-streams/${runId}.log`,
    fileExists: path => existingLogs.includes(path),
  };
}

describe('recut-4626: fleet outcome-why', () => {
  it('is registered and resolves to an exported cmdFleetOutcomeWhy', async () => {
    const resolved = resolveFleetSubcommand('outcome-why');
    expect(resolved).toEqual({ module: './fleet-outcome-why.js', exportName: 'cmdFleetOutcomeWhy' });
    const loaded = await FLEET_SUBCOMMAND_LOADERS['outcome-why']!();
    expect(typeof loaded['cmdFleetOutcomeWhy']).toBe('function');
  });

  it('explains one failed outcome with its failed task and existing log path', async () => {
    const result = await explainOutcome('continuously-improve-phantom',
      deps([view()], ['/home/test/.ashlr/run-streams/run-aaa.log']));
    expect(result).toMatchObject({
      v: 1, id: 'continuously-improve-phantom', status: 'failed', headline: '1 of 2 tasks failed',
      failedTasks: [{ key: 'fix-flaky-test', state: 'failed', runId: 'run-aaa', logPath: '/home/test/.ashlr/run-streams/run-aaa.log' }],
      manager: { latestState: null },
    });
  });

  it('with no id lists only failed outcomes', async () => {
    const running = view({ id: 'beta', status: 'running', tasks: [task('running', 'run-b')] });
    const result = await explainOutcome(null, deps([view({ id: 'alpha' }), running]));
    if ('error' in result || !('outcomes' in result)) throw new Error('expected a list');
    expect(result.outcomes.map(outcome => outcome.id)).toEqual(['alpha']);
  });

  it('unknown id answers not-found; degraded ledger answers source-unavailable', async () => {
    expect(await explainOutcome('missing', deps([view()]))).toEqual({ v: 1, id: 'missing', error: 'not-found' });
    expect(await explainOutcome(null, deps(null))).toEqual({ v: 1, id: null, error: 'source-unavailable' });
  });
});
