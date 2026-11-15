import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOutcomeWhy } from '../src/cli/fleet-outcome-why.js';
import type { ExplainOutcomeDeps, OutcomeTaskView, OutcomeView, OutcomesRead } from '../src/core/fleet/outcome-why.js';

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
    tasks: [task('failed', 'run-aaa', 'fix-flaky-test')],
    ...over,
  };
}

function healthy(outcomes: OutcomeView[]): OutcomesRead {
  return { v: 1, sourceState: 'healthy', outcomes, enrollment: { sourceState: 'healthy', repos: ['ashlrai/phantom'] } };
}

const DEGRADED: OutcomesRead = { v: 1, sourceState: 'degraded', outcomes: null, enrollment: { sourceState: 'degraded', repos: null } };

function deps(body: OutcomesRead, existingLogs: string[] = []): ExplainOutcomeDeps {
  return {
    run: async () => body,
    logPathFor: runId => `/home/test/.ashlr/run-streams/${runId}.log`,
    fileExists: path => existingLogs.includes(path),
  };
}

let output: string[];
let errors: string[];
beforeEach(() => {
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation((value: unknown) => { errors.push(String(value)); });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet outcome-why cli', () => {
  it('--json prints the single explanation and exits 0', async () => {
    const outcome = view();
    expect(await cmdFleetOutcomeWhy([outcome.id, '--json'], deps(healthy([outcome])))).toBe(0);
    const parsed = JSON.parse(output[0]!);
    expect(parsed).toMatchObject({
      v: 1, id: outcome.id, status: 'failed', headline: '1 of 1 tasks failed',
      failedTasks: [{ key: 'fix-flaky-test', state: 'failed', runId: 'run-aaa', logPath: null }],
      manager: { latestState: null },
    });
  });

  it('human output shows status, headline, task rows, manager state and the log path', async () => {
    const outcome = view();
    expect(await cmdFleetOutcomeWhy([outcome.id], deps(healthy([outcome]), ['/home/test/.ashlr/run-streams/run-aaa.log']))).toBe(0);
    expect(output).toEqual([
      'outcome continuously-improve-phantom: failed',
      '1 of 1 tasks failed',
      'manager latest: none',
      'failed tasks:',
      '  fix-flaky-test (failed) repo=ashlrai/phantom run=run-aaa',
      '    log: /home/test/.ashlr/run-streams/run-aaa.log',
      `next: Read the log of run run-aaa at /home/test/.ashlr/run-streams/run-aaa.log to see why task fix-flaky-test failed.`,
    ]);
  });

  it('unknown id prints not-found on stderr, JSON on stdout, and exits 1', async () => {
    expect(await cmdFleetOutcomeWhy(['missing'], deps(healthy([view()])))).toBe(1);
    expect(errors).toEqual(['outcome missing not found']);
    output = []; errors = [];
    expect(await cmdFleetOutcomeWhy(['missing', '--json'], deps(healthy([view()])))).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({ v: 1, id: 'missing', error: 'not-found' });
  });

  it('source-unavailable exits 0 with a clear line', async () => {
    expect(await cmdFleetOutcomeWhy(['anything'], deps(DEGRADED))).toBe(0);
    expect(output).toEqual(['outcome records are unavailable: the outcome ledger could not be read']);
  });

  it('with no id prints every failed outcome', async () => {
    const failed = view({ id: 'alpha' });
    const running = view({ id: 'beta', status: 'running' });
    expect(await cmdFleetOutcomeWhy([], deps(healthy([failed, running])))).toBe(0);
    expect(output[0]).toBe('outcome alpha: failed');
    expect(output.some(line => line.includes('beta'))).toBe(false);
  });

  it('with no id and no failures prints a clean empty line', async () => {
    expect(await cmdFleetOutcomeWhy([], deps(healthy([view({ id: 'beta', status: 'running' })])))).toBe(0);
    expect(output).toEqual(['no failed outcomes']);
  });

  it('prints usage for bad args and exits 2', async () => {
    expect(await cmdFleetOutcomeWhy(['a', 'b'], deps(healthy([])))).toBe(2);
    expect(errors[0]).toMatch(/^Usage: ashlr fleet outcome-why/);
  });

  it('--help prints usage and exits 0', async () => {
    expect(await cmdFleetOutcomeWhy(['--help'])).toBe(0);
    expect(output[0]).toMatch(/^Usage: ashlr fleet outcome-why/);
  });
});
