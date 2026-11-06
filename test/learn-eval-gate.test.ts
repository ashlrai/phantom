import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promoteWithEval, type EvalCandidate, type EvalGateOptions } from '../src/core/learn/eval-gate.js';
import { routingTasks } from './fixtures/eval/routing.js';

type Config = Record<string, string>;
type Input = { category: string; expected: string };
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'eval-gate-'));
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function setup(kind: 'prior' | 'prompt' | 'playbook' = 'prior') {
  let active: Config = { docs: 'local', security: 'frontier', bug: 'local' };
  let revision = 'v1';
  const apply = vi.fn((candidate: EvalCandidate<Config>) => {
    if (candidate.baseRevision !== revision) return false;
    active = candidate.value;
    revision = 'v2';
    return true;
  });
  const options: EvalGateOptions<Config, Input> = {
    candidate: { id: 'candidate-1', kind, baseRevision: revision,
      value: { docs: 'local', security: 'frontier', bug: 'frontier' } },
    baseline: active,
    tasks: routingTasks,
    replay: (task, config) => Number(config[task.input.category] === task.input.expected),
    apply,
  };
  return { options, apply, active: () => active, advance: () => { revision = 'v3'; } };
}

function ledger() {
  return readFileSync(join(home, '.ashlr', 'learn', 'eval-gate.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

describe('held-out learning promotion', () => {
  it.each(['prior', 'prompt', 'playbook'] as const)('promotes a measured %s gain', async kind => {
    const state = setup(kind);
    const result = await promoteWithEval(state.options);
    expect(result.status).toBe('promoted');
    expect(result.pairs).toHaveLength(3);
    expect(state.apply).toHaveBeenCalledTimes(1);
    expect(state.active().bug).toBe('frontier');
    expect(ledger().map(row => row.status)).toEqual(['evaluated', 'promoted']);
  });

  it('blocks regression and records the reason without changing active state', async () => {
    const state = setup();
    state.options.candidate.value.security = 'local';
    const before = structuredClone(state.active());
    expect(await promoteWithEval(state.options)).toMatchObject({ status: 'rejected', reason: 'regression' });
    expect(state.apply).not.toHaveBeenCalled();
    expect(state.active()).toEqual(before);
    expect(ledger()[0]).toMatchObject({ candidateId: 'candidate-1', reason: 'regression' });
  });

  it('does not let an aggregate gain conceal a task regression', async () => {
    const { options, apply } = setup();
    options.replay = (task, config) => config.bug === 'local' ? 0.5 : task.id === 'auth-review' ? 0.4 : 1;
    expect((await promoteWithEval(options)).reason).toBe('regression');
    expect(apply).not.toHaveBeenCalled();
  });

  it('allows a tie with complete evidence', async () => {
    const { options, apply } = setup();
    options.candidate.value = options.baseline;
    expect((await promoteWithEval(options)).status).toBe('promoted');
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each([{ tasks: undefined }, { tasks: null }, { tasks: [] }])('blocks absent held-out tasks: $tasks', async ({ tasks }) => {
    const { options, apply } = setup();
    options.tasks = tasks;
    expect((await promoteWithEval(options)).reason).toBe('missing-data');
    expect(apply).not.toHaveBeenCalled();
    expect(ledger()[0].status).toBe('rejected');
  });

  it.each([null, undefined, NaN, Infinity, -0.1, 1.1])('blocks missing or invalid scores: %s', async score => {
    const { options, apply } = setup();
    options.replay = () => score as number | null;
    expect((await promoteWithEval(options)).reason).toBe(score == null ? 'missing-data' : 'invalid-data');
    expect(apply).not.toHaveBeenCalled();
  });

  it('blocks a missing candidate score even with a valid baseline', async () => {
    const { options, apply } = setup();
    options.replay = (_task, config) => config.bug === 'local' ? 1 : null;
    expect((await promoteWithEval(options)).reason).toBe('missing-data');
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects duplicate task identities', async () => {
    const { options, apply } = setup();
    options.tasks = [routingTasks[0], routingTasks[0]];
    expect((await promoteWithEval(options)).reason).toBe('invalid-data');
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(['baseline', 'candidate'] as const)('blocks absent %s configuration', async arm => {
    const { options, apply } = setup();
    if (arm === 'baseline') options.baseline = undefined as unknown as Config;
    else options.candidate.value = undefined as unknown as Config;
    expect((await promoteWithEval(options)).reason).toBe('missing-data');
    expect(apply).not.toHaveBeenCalled();
  });

  it('blocks configuration that cannot be snapshotted', async () => {
    const { options, apply } = setup();
    options.candidate.value = { method: () => 1 } as unknown as Config;
    expect((await promoteWithEval(options)).reason).toBe('invalid-data');
    expect(apply).not.toHaveBeenCalled();
  });

  it('logs evaluator failure without leaking task, candidate or error contents', async () => {
    const { options, apply } = setup();
    options.candidate.value.private = 'candidate-private';
    options.replay = () => { throw new Error('private-error-details'); };
    expect((await promoteWithEval(options)).reason).toBe('evaluation-failed');
    expect(apply).not.toHaveBeenCalled();
    const log = JSON.stringify(ledger());
    expect(log).not.toContain('private');
    expect(log).not.toContain('expected');
  });

  it('applies the evaluated snapshot despite caller and scorer mutations', async () => {
    const { options, active } = setup();
    const replay = options.replay;
    options.replay = async (task, config) => {
      options.candidate.value.bug = 'mutated';
      const score = await replay(task, config);
      config.bug = 'mutated';
      task.id = 'mutated';
      return score;
    };
    const result = await promoteWithEval(options);
    expect(result.status).toBe('promoted');
    expect(active().bug).toBe('frontier');
    expect(result.pairs.map(pair => pair.taskId)).toEqual(routingTasks.map(task => task.id));
  });

  it('blocks stale baseline at the atomic apply boundary', async () => {
    const state = setup();
    state.advance();
    expect((await promoteWithEval(state.options)).reason).toBe('stale-baseline');
    expect(state.active().bug).toBe('local');
  });

  it('records apply failure without claiming promotion', async () => {
    const { options } = setup();
    options.apply = () => { throw new Error('storage unavailable'); };
    expect((await promoteWithEval(options)).reason).toBe('apply-failed');
    expect(ledger().at(-1).status).toBe('rejected');
  });

  it('does not apply if the audit trail cannot be written', async () => {
    const { options, apply } = setup();
    mkdirSync(join(home, '.ashlr'));
    writeFileSync(join(home, '.ashlr', 'learn'), 'not a directory');
    await expect(promoteWithEval(options)).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
});
