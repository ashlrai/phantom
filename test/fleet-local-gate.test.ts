import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalGate, type LocalGateDeps } from '../src/core/fleet/local-gate.js';
import { cmdFleetLocalGate } from '../src/cli/fleet-local-gate.js';

const ready = { state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };

function fixture() {
  let elapsed = 0;
  const exec = vi.fn(async (command: string, args: string[]) => {
    elapsed += 1;
    return { ok: true, stdout: command === 'gh' ? JSON.stringify(ready) : command === 'git' ? (args[0] === 'rev-parse' ? 'a' : 'b').repeat(40) : 'password=plainly-fake-value', stderr: '' };
  });
  const deps: LocalGateDeps = { exec, now: () => elapsed, appendMetric: vi.fn(async () => {}), warn: vi.fn(), metricsPath: '/fake/metrics/local-gate.jsonl' };
  return { exec, deps };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet local-gate', () => {
  it('runs both checks in order and appends one output-free verdict row', async () => {
    const { exec, deps } = fixture();
    const report = await runLocalGate(undefined, deps);
    expect(report).toEqual({ verdict: 'pass', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), steps: [
      { name: 'typecheck', ok: true, seconds: 1 }, { name: 'verify-changed', ok: true, seconds: 1 },
      { name: 'merge readiness', ok: true, seconds: 1, blockers: [] },
    ], seconds: 5 });
    expect(exec.mock.calls.slice(2, 4)).toEqual([
      ['npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], expect.any(String)],
      ['node', ['scripts/verify-changed.mjs'], expect.any(String)],
    ]);
    expect(deps.appendMetric).toHaveBeenCalledExactlyOnceWith('/fake/metrics/local-gate.jsonl', JSON.stringify(report) + '\n');
    expect(JSON.stringify(report)).not.toContain('plainly-fake-value');
  });

  it('continues to verification after typecheck throws', async () => {
    const { exec, deps } = fixture();
    exec.mockImplementationOnce(async () => ({ ok: true, stdout: 'a'.repeat(40), stderr: '' }))
      .mockImplementationOnce(async () => ({ ok: true, stdout: 'b'.repeat(40), stderr: '' }))
      .mockRejectedValueOnce(new Error('password=plainly-fake-value'));
    const report = await runLocalGate(180, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps.map(step => step.ok)).toEqual([false, true, true]);
    expect(exec).toHaveBeenCalledTimes(5);
  });

  it('adds a fail row for a budget overrun after running both steps', async () => {
    const { exec, deps } = fixture();
    const report = await runLocalGate(3, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps.at(-1)).toEqual({ name: 'budget', ok: false, seconds: 5 });
    expect(exec).toHaveBeenCalledTimes(5);
  });

  it('warns without failing when the metrics file is unwritable', async () => {
    const { deps } = fixture();
    deps.appendMetric = vi.fn().mockRejectedValue(new Error('permission denied'));
    expect((await runLocalGate(180, deps)).verdict).toBe('pass');
    expect(deps.warn).toHaveBeenCalledExactlyOnceWith('warning: could not append local-gate metrics');
  });

  it('fails closed for missing git identity while still running checks', async () => {
    const { exec, deps } = fixture();
    exec.mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'fake git error' });
    const report = await runLocalGate(180, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps[0].name).toBe('git identity');
    expect(exec).toHaveBeenCalledTimes(5);
  });

  it('prints JSON and returns 1 for a failed check', async () => {
    const { deps } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLocalGate(['--json', '--budget-seconds', '1'], deps)).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0]).verdict).toBe('fail');
  });

  it('prints step and total PASS lines and returns zero', async () => {
    const { deps } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLocalGate([], deps)).toBe(0);
    expect(log.mock.calls[0][0]).toBe('PASS typecheck (1.00s)\nPASS verify-changed (1.00s)\nPASS merge readiness (1.00s)\nPASS total (5.00s)');
  });

  it.each([
    ['branch-behind', { mergeStateStatus: 'BEHIND' }, 'Fetch the base branch'],
    ['pending-check', { statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, 'gh pr checks --watch'],
    ['conflict', { mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }, 'resolve conflicts'],
    ['failed-check', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'fix the failing checks'],
    ['unknown', { mergeStateStatus: 'FUTURE_STATE' }, 'gh pr view'],
    ['pending-check', { statusCheckRollup: [{ status: 'FUTURE_STATE' }] }, 'gh pr checks --watch'],
    ['unknown', { isDraft: true }, 'gh pr view'],
    ['unknown', { state: 'CLOSED' }, 'gh pr view'],
    ['unknown', { mergeable: 'UNKNOWN' }, 'gh pr view'],
    ['unknown', { headRefOid: 'c'.repeat(40) }, 'gh pr view'],
    ['unknown', { statusCheckRollup: [] }, 'gh pr view'],
    ['unknown', { statusCheckRollup: null }, 'gh pr view'],
  ])('reports %s with an actionable next step', async (kind, state, action) => {
    const { exec, deps } = fixture();
    const fallback = exec.getMockImplementation()!;
    exec.mockImplementation(async (command, args) => command === 'gh'
      ? { ok: true, stdout: JSON.stringify({ ...ready, ...state }), stderr: '' }
      : fallback(command, args));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLocalGate([], deps)).toBe(1);
    expect(log.mock.calls[0][0]).toContain(`${kind}:`);
    expect(log.mock.calls[0][0]).toContain(action);
    const report = JSON.parse(vi.mocked(deps.appendMetric!).mock.calls[0][1]);
    expect(report.verdict).toBe('fail');
    expect(report.steps.at(-1).blockers).toContainEqual({ kind, nextStep: expect.stringContaining(action) });
  });

  it.each(['malformed', '{}', 'null', '[]'])('fails closed for unavailable PR evidence: %s', async stdout => {
    const { exec, deps } = fixture();
    const fallback = exec.getMockImplementation()!;
    exec.mockImplementation(async (command, args) => command === 'gh'
      ? { ok: true, stdout, stderr: 'password=plainly-fake-value' } : fallback(command, args));
    const report = await runLocalGate(180, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps.at(-1)?.blockers?.[0].kind).toBe('unknown');
    expect(JSON.stringify(report)).not.toContain('plainly-fake-value');
  });

  it('reports simultaneous behind and pending blockers', async () => {
    const { exec, deps } = fixture();
    const fallback = exec.getMockImplementation()!;
    exec.mockImplementation(async (command, args) => command === 'gh'
      ? { ok: true, stdout: JSON.stringify({ ...ready, mergeStateStatus: 'BEHIND', statusCheckRollup: [{ state: 'PENDING' }] }), stderr: '' }
      : fallback(command, args));
    const report = await runLocalGate(180, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps.at(-1)?.blockers?.map(blocker => blocker.kind)).toEqual(['branch-behind', 'pending-check']);
  });

  it('fails closed when the PR reader throws', async () => {
    const { exec, deps } = fixture();
    const fallback = exec.getMockImplementation()!;
    exec.mockImplementation(async (command, args) => {
      if (command === 'gh') throw new Error('unavailable');
      return fallback(command, args);
    });
    expect((await runLocalGate(180, deps)).verdict).toBe('fail');
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])('rejects invalid budget %s without running children', async value => {
    const { exec, deps } = fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleetLocalGate(['--budget-seconds', value], deps)).toBe(2);
    expect(exec).not.toHaveBeenCalled();
  });
});
