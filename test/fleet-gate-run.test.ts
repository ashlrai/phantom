import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGateRun } from '../src/cli/fleet-gate-run.js';
import { RUNS_SWITCHES, type RunsSwitchesV1 } from '../src/core/fleet/runs-switches.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gate-run-'));
  roots.push(root);
  return root;
}
const controls = (on: string[] = [], sourceState: RunsSwitchesV1['sourceState'] = 'healthy'): RunsSwitchesV1 => ({
  v: 1, sourceState, switches: RUNS_SWITCHES.map(({ id, effect }) => ({ id, effect, on: on.includes(id), since: null })),
});
const worker = (script: string, ...args: string[]) => ['--', process.execPath, '-e', script, ...args];
const writeFile = "require('node:fs').writeFileSync('result', JSON.stringify(process.argv.slice(1)))";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('fleet gate-run', () => {
  it('discovers the command and gates once after the worker closes in the same cwd', async () => {
    const cwd = await temp();
    const gate = vi.fn(async (budget: number, dir: string) => {
      expect(budget).toBe(12.5);
      expect(dir).toBe(cwd);
      expect(JSON.parse(await readFile(join(dir, 'result'), 'utf8'))).toEqual(['a; touch unexpected', '$(literal)', '--']);
      return { verdict: 'pass' as const };
    });
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveFleetSubcommand('gate-run')).toEqual({ module: './fleet-gate-run.js', exportName: 'cmdFleetGateRun' });
    expect(await cmdFleetGateRun(['--budget-seconds', '12.5', ...worker(writeFile, 'a; touch unexpected', '$(literal)', '--')],
      { cwd, readControls: async () => controls(), gate })).toBe(0);
    expect(gate).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalledExactlyOnceWith('fleet gate-run: pass\n');
    await expect(readFile(join(cwd, 'unexpected'))).rejects.toThrow();
  });

  it('fails when the gate fails or throws and does not disclose errors', async () => {
    const cwd = await temp();
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const gate = vi.fn().mockResolvedValueOnce({ verdict: 'fail' }).mockRejectedValueOnce(new Error('private detail'));
    for (let i = 0; i < 2; i++) {
      expect(await cmdFleetGateRun(worker(''), { cwd, readControls: async () => controls(), gate })).toBe(1);
    }
    expect(gate).toHaveBeenCalledTimes(2);
    expect(err.mock.calls.flat().join('')).not.toContain('private detail');
  });

  it('preserves worker failure and skips the gate, including spawn errors', async () => {
    const cwd = await temp();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const gate = vi.fn();
    const deps = { cwd, readControls: async () => controls(), gate };
    expect(await cmdFleetGateRun(worker('process.exit(7)'), deps)).toBe(7);
    expect(await cmdFleetGateRun(['--', join(cwd, 'missing')], deps)).toBe(1);
    expect(gate).not.toHaveBeenCalled();
  });

  it.each(['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE', 'degraded', 'reader throws'])('refuses to spawn with %s controls', async state => {
    const cwd = await temp();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const gate = vi.fn();
    const readControls = async () => {
      if (state === 'reader throws') throw new Error('private detail');
      return state === 'degraded' ? controls([], 'degraded') : controls([state]);
    };
    expect(await cmdFleetGateRun(worker(writeFile), { cwd, readControls, gate })).toBe(1);
    await expect(readFile(join(cwd, 'result'))).rejects.toThrow();
    expect(gate).not.toHaveBeenCalled();
  });

  it('permits missing controls and unrelated switches', async () => {
    const cwd = await temp();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const gate = vi.fn(async () => ({ verdict: 'pass' as const }));
    expect(await cmdFleetGateRun(worker(''), { cwd, readControls: async () => controls(['PUBLISH_HOLD'], 'missing'), gate })).toBe(0);
    expect(gate).toHaveBeenCalledOnce();
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s, escalates an ignoring worker, and never gates', async signal => {
    const cwd = await temp();
    const signals = new EventEmitter();
    const gate = vi.fn();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const script = `process.on('${signal}', () => require('node:fs').writeFileSync('signalled', 'yes')); require('node:fs').writeFileSync('ready', 'yes'); setInterval(() => {}, 1000)`;
    const run = cmdFleetGateRun(worker(script), { cwd, readControls: async () => controls(), gate, signals, escalationMs: 500 });
    const deadline = Date.now() + 5000;
    while (true) {
      try { await readFile(join(cwd, 'ready')); break; }
      catch { if (Date.now() > deadline) throw new Error('worker did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    signals.emit(signal);
    expect(await run).toBe(signal === 'SIGINT' ? 130 : 143);
    expect(gate).not.toHaveBeenCalled();
    expect(await readFile(join(cwd, 'signalled'), 'utf8')).toBe('yes');
    expect(signals.listenerCount(signal)).toBe(0);
  });

  it('cannot report success if interrupted during the gate', async () => {
    const cwd = await temp();
    const signals = new EventEmitter();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const gate = vi.fn(async () => { signals.emit('SIGTERM'); return { verdict: 'pass' as const }; });
    expect(await cmdFleetGateRun(worker(''), { cwd, readControls: async () => controls(), gate, signals })).toBe(143);
    expect(gate).toHaveBeenCalledOnce();
  });

  it.each([[], ['--'], ['node'], ['--budget-seconds', '0', '--', 'node'],
    ['--budget-seconds', 'Infinity', '--', 'node'], ['--budget-seconds', '', '--', 'node'],
    ['--budget-seconds', '1', '--budget-seconds', '2', '--', 'node'], ['--unknown', '--', 'node']].map(args => [args]))('rejects invalid arguments %#', async args => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const readControls = vi.fn();
    expect(await cmdFleetGateRun(args, { readControls })).toBe(2);
    expect(readControls).not.toHaveBeenCalled();
  });
});
