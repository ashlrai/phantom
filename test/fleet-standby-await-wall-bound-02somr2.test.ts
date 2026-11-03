import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStandbyAwait, type FleetStandbyAwaitDeps } from '../src/cli/fleet-standby-await.js';

const blocked = { version: 1, ready: false, blockers: ['no-snapshot'], wouldLoseSec: null };
const ready = { version: 1, ready: true, blockers: [], wouldLoseSec: 0 };
const output = (report: unknown) => ({ stdout: JSON.stringify(report), stderr: '' });
let dir: string;
let writes: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  dir = mkdtempSync(join(tmpdir(), 'standby-wall-'));
  writeFileSync(join(dir, 'standby.json'), JSON.stringify({ v: 1, db: '/tmp/fake-db', snapshotStore: '/tmp/fake-snap', primary: 'fake-primary', role: 'leader', host: 'fake-standby', maxAgeSec: 600 }));
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function run(deps: FleetStandbyAwaitDeps, timeout = 1000) {
  return cmdFleetStandbyAwait(['--timeout-ms', String(timeout), '--interval-ms', '100', '--json'], { runsDir: dir, ...deps });
}
function report() { return JSON.parse(writes.join('')) as { outcome: string; attempts: number; lastReport: unknown }; }

describe('standby-await wall deadline', () => {
  it('times out hung discovery without spawning', async () => {
    const exec = vi.fn();
    const result = run({ locateScript: () => new Promise(() => {}), exec });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(3);
    expect(exec).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ outcome: 'timeout', attempts: 0, lastReport: null });
  });

  it('times out a hung probe and ignores its late ready result', async () => {
    let resolve!: (value: ReturnType<typeof output>) => void;
    const exec = vi.fn(() => new Promise<ReturnType<typeof output>>((r) => { resolve = r; }));
    const result = run({ locateScript: () => '/fake/script', exec });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(3);
    resolve(output(ready));
    await vi.runAllTimersAsync();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(report()).toMatchObject({ outcome: 'timeout', lastReport: null });
  });

  it('retains the previous blocked report after a hung probe', async () => {
    const exec = vi.fn().mockResolvedValueOnce(output(blocked)).mockImplementationOnce(() => new Promise(() => {}));
    const result = run({ locateScript: () => '/fake/script', exec });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(3);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(report()).toMatchObject({ outcome: 'timeout', attempts: 2, lastReport: blocked });
  });

  it('treats the shorter probe cap as an error', async () => {
    const result = run({ locateScript: () => '/fake/script', exec: () => new Promise(() => {}) }, 40000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await result).toBe(1);
    expect(report()).toMatchObject({ outcome: 'error', attempts: 1 });
  });

  it('succeeds after a blocked report and a nonzero child with a valid ready report', async () => {
    const exec = vi.fn().mockResolvedValueOnce(output(blocked)).mockRejectedValueOnce({ code: 1, stdout: JSON.stringify(ready) });
    const result = run({ locateScript: () => '/fake/script', exec });
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe(0);
    expect(report()).toMatchObject({ outcome: 'ready', attempts: 2, lastReport: ready });
  });
});
