import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianBus } from '../src/cli/fleet-guardian-bus.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'guardian-bound-')); dirs.push(root);
  const args = ['--bus-from', 'a', '--bus-to', 'b', '--bus-run-id', 'r', '--bus-runs-dir', root,
    '--manifest', join(root, 'manifest'), '--source-state', join(root, 'source'), '--output-dir', root,
    '--max-retries', '2', '--timeout-ms', '60000'];
  let selected = 0;
  const select = vi.fn(async () => ({ repo: join(root, `fake-${++selected}`), sha: String(selected).repeat(40) }));
  const prepare = vi.fn(async () => undefined);
  const verify = vi.fn(async () => ({ state: 'ran', summary: { deadlineExceeded: false, cancelled: false } }) as GuardianVerifyExclusiveResult);
  const lines: string[] = [];
  const writeLine = (line: string) => { lines.push(line); };
  return { args, select, prepare, verify, lines, writeLine };
}

describe('guardian bus delivery deadline', () => {
  it('bounds a stalled append and stops the real drain with a final failure summary', async () => {
    const o = setup();
    const append = vi.fn(() => new Promise<never>(() => {}));
    const start = Date.now();
    expect(await cmdFleetGuardianBus([...o.args, '--apply', '--bus-delivery-timeout-ms', '25'], { ...o, append })).toBe(3);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(o.verify).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(o.lines.map(line => JSON.parse(line))).toMatchObject([
      { record: 'attempt' }, { record: 'summary', termination: 'observer-error', attempts: 1 },
    ]);
  });

  it('cleans delivery timers after successful and rejected appends', async () => {
    const o = setup();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const append = vi.fn().mockResolvedValue({ status: 'duplicate' });
    expect(await cmdFleetGuardianBus([...o.args, '--apply', '--bus-delivery-timeout-ms', '1234'], { ...o, append })).toBe(0);
    const timers = set.mock.results.filter((_, i) => set.mock.calls[i]?.[1] === 1234).map(r => r.value);
    expect(timers).toHaveLength(3);
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);
    const rejected = setup();
    expect(await cmdFleetGuardianBus([...rejected.args, '--apply', '--bus-delivery-timeout-ms', '1234'], {
      ...rejected, append: async () => { throw new Error('synthetic'); },
    })).toBe(3);
    const lastTimer = set.mock.results.filter((_, i) => set.mock.calls[i]?.[1] === 1234).at(-1)!.value;
    expect(clear).toHaveBeenCalledWith(lastTimer);
    expect(JSON.parse(rejected.lines.at(-1)!).termination).toBe('observer-error');
  });

  it('handles rejection after the deadline without another append', async () => {
    const o = setup();
    let reject!: (error: Error) => void;
    const append = vi.fn(() => new Promise<never>((_, fail) => { reject = fail; }));
    expect(await cmdFleetGuardianBus([...o.args, '--apply', '--bus-delivery-timeout-ms', '10'], { ...o, append })).toBe(3);
    reject(new Error('late synthetic rejection'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(append).toHaveBeenCalledTimes(1);
    expect(JSON.parse(o.lines.at(-1)!).termination).toBe('observer-error');
  });

  it('does not append during dry runs', async () => {
    const o = setup(); const append = vi.fn(() => ({ status: 'full' as const }));
    expect(await cmdFleetGuardianBus([...o.args, '--bus-delivery-timeout-ms', '10'], { ...o, append })).toBe(0);
    expect(append).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });

  it('rejects invalid timeout arguments before drain admission', async () => {
    const o = setup(); const drain = vi.fn(async () => 0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const extra of [
      ['--bus-delivery-timeout-ms'], ['--bus-delivery-timeout-ms', '0'], ['--bus-delivery-timeout-ms', '-1'],
      ['--bus-delivery-timeout-ms', '01'], ['--bus-delivery-timeout-ms', '1.5'], ['--bus-delivery-timeout-ms', '60001'],
      ['--bus-delivery-timeout-ms', '9007199254740992'], ['--bus-delivery-timeout-ms', '1', '--bus-delivery-timeout-ms', '2'],
    ]) expect(await cmdFleetGuardianBus([...o.args, ...extra], { ...o, drain })).toBe(2);
    expect(drain).not.toHaveBeenCalled();
    expect(o.select).not.toHaveBeenCalled();
    expect(o.verify).not.toHaveBeenCalled();
  });
});
