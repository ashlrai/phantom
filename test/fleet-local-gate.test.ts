import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalGate, type LocalGateDeps } from '../src/core/fleet/local-gate.js';
import { cmdFleetLocalGate } from '../src/cli/fleet-local-gate.js';

const dirs: string[] = [];

function fixture() {
  let elapsed = 0;
  const cwd = mkdtempSync(join(tmpdir(), 'local-gate-cwd-'));
  dirs.push(cwd);
  const exec = vi.fn(async (command: string, args: string[]) => {
    elapsed += 1;
    return { ok: true, stdout: command === 'git' ? (args[0] === 'rev-parse' ? 'a' : 'b').repeat(40) : 'password=plainly-fake-value', stderr: '' };
  });
  const deps: LocalGateDeps = { exec, cwd, now: () => elapsed, appendMetric: vi.fn(async () => {}), warn: vi.fn(), metricsPath: '/fake/metrics/local-gate.jsonl' };
  return { exec, deps, cwd };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fleet local-gate', () => {
  it('runs both checks in order and appends one output-free verdict row', async () => {
    const { exec, deps, cwd } = fixture();
    const report = await runLocalGate(undefined, deps);
    expect(report).toEqual({ verdict: 'pass', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), steps: [
      { name: 'typecheck', ok: true, seconds: 1 }, { name: 'verify-changed', ok: true, seconds: 1 },
    ], seconds: 4 });
    expect(exec.mock.calls.slice(2)).toEqual([
      ['node', [join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'], cwd],
      ['node', ['scripts/verify-changed.mjs'], cwd],
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
    expect(report.steps.map(step => step.ok)).toEqual([false, true]);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('adds a fail row for a budget overrun after running both steps', async () => {
    const { exec, deps } = fixture();
    const report = await runLocalGate(3, deps);
    expect(report.verdict).toBe('fail');
    expect(report.steps.at(-1)).toEqual({ name: 'budget', ok: false, seconds: 4 });
    expect(exec).toHaveBeenCalledTimes(4);
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
    expect(exec).toHaveBeenCalledTimes(4);
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
    expect(log.mock.calls[0][0]).toBe('PASS typecheck (1.00s)\nPASS verify-changed (1.00s)\nPASS total (4.00s)');
  });

  it.each(['0', '-1', 'NaN', 'Infinity'])('rejects invalid budget %s without running children', async value => {
    const { exec, deps } = fixture();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await cmdFleetLocalGate(['--budget-seconds', value], deps)).toBe(2);
    expect(exec).not.toHaveBeenCalled();
  });
});
