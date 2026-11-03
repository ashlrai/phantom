import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsEnsure, type AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const success = (app: string) => ({ code: 0, stdout: JSON.stringify({ app, outcome: 'running', running: true }) });
beforeEach(() => {
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('stops after a child exhausts the wall budget with a frozen clock', async () => {
  vi.useFakeTimers();
  const runner = vi.fn<AppsEnsureChildRunner>(() => new Promise(() => {}));
  const pending = cmdFleetAppsEnsure(['Cursor', 'Claude', '--timeout-ms', '100', '--json'], { runChild: runner, now: () => 0 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output)).toMatchObject({ endedBy: 'deadline', apps: [
    { attempted: true, outcome: 'timeout' }, { attempted: false, outcome: 'unattempted', reason: 'deadline' },
  ] });
});

it('forwards the monotonic remainder when the injected clock moves backward', async () => {
  let wall = 0;
  let clock = 1000;
  const runner = vi.fn<AppsEnsureChildRunner>(async args => {
    wall += 400;
    clock -= 500;
    return success(args[2]!);
  });
  expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--timeout-ms', '1000', '--json'], {
    runChild: runner, now: () => clock, monotonicNow: () => wall,
  })).toBe(0);
  expect(runner.mock.calls[1]![0]).toContain('600');
  expect(runner.mock.calls[1]![1].timeoutMs).toBe(600);
  expect(JSON.parse(output)).toMatchObject({ ok: true, endedBy: 'complete' });
});

it('does not invoke a child if the deadline expires after the batch check', async () => {
  let calls = 0;
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsEnsure(['Cursor', '--timeout-ms', '100', '--json'], {
    runChild: runner, now: () => 0, monotonicNow: () => ++calls < 3 ? 0 : 100,
  })).toBe(1);
  expect(runner).not.toHaveBeenCalled();
  expect(JSON.parse(output)).toMatchObject({ endedBy: 'deadline', apps: [{ attempted: false, reason: 'deadline' }] });
});
