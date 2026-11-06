import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const events = () => output.trim().split('\n').map(line => JSON.parse(line));
const batch = (apps: object[], ok = true, code = 0) => ({ code, stdout: JSON.stringify({ ok, apps }) });
const healthy = batch([{ app: 'Cursor', observedRunning: true }, { app: 'Phantom', observedRunning: true }]);
const args = ['Phantom', 'Cursor', '--duration-ms', '200', '--interval-ms', '100', '--jsonl'];
let clock: number;
beforeEach(() => {
  clock = 0;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });
const deps = (runChild: AppsEnsureChildRunner) => ({ runChild, now: () => clock, sleep: async (ms: number) => { clock += ms; } });

it.each([
  ['malformed JSON', { code: 0, stdout: '{' }],
  ['mismatched rows', batch([{ app: 'Phantom', observedRunning: true }])],
  ['duplicate rows', batch([{ app: 'Phantom', observedRunning: true }, { app: 'Phantom', observedRunning: true }])],
])('clears a healthy sample after %s', async (_name, invalid) => {
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValueOnce(healthy).mockResolvedValueOnce(invalid);
  expect(await cmdFleetAppsWatch(args, deps(runner))).toBe(1);
  expect(events()).toMatchObject([
    { healthy: true, observedState: [{ app: 'Phantom', observedRunning: true }, { app: 'Cursor', observedRunning: true }] },
    { healthy: false, observedState: null },
    { outcome: 'failed', cycles: 2, lastObservedState: null },
  ]);
  expect(runner).toHaveBeenCalledTimes(2);
});

it.each([null, undefined, 'false', 0])('distinguishes unknown %s from an explicitly stopped app', async observed => {
  const result = batch([{ app: 'Cursor', observedRunning: observed }, { app: 'Phantom', observedRunning: false }], false, 1);
  expect(await cmdFleetAppsWatch(args, deps(async () => result))).toBe(1);
  const state = [{ app: 'Phantom', observedRunning: false }, { app: 'Cursor', observedRunning: null }];
  expect(events()).toMatchObject([{ healthy: false, observedState: state }, { outcome: 'failed', lastObservedState: state }]);
});

it('recovers after a failed cycle without extra retries', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValueOnce({ code: 0, stdout: '{' }).mockResolvedValueOnce(healthy);
  expect(await cmdFleetAppsWatch([...args, '--max-consecutive-failures', '2'], deps(runner))).toBe(0);
  expect(events()).toMatchObject([
    { healthy: false, observedState: null, consecutiveFailures: 1 },
    { healthy: true, consecutiveFailures: 0, totalFailedCycles: 1 },
    { outcome: 'completed', cycles: 2, lastObservedState: [{ app: 'Phantom', observedRunning: true }, { app: 'Cursor', observedRunning: true }] },
  ]);
  expect(runner).toHaveBeenCalledTimes(2);
});

it.each(['rejection', 'timeout'] as const)('clears the prior sample on child %s', async failure => {
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValueOnce(healthy).mockImplementationOnce(() =>
    failure === 'rejection' ? Promise.reject(new Error('failed')) : new Promise(() => {}));
  expect(await cmdFleetAppsWatch(['Phantom', 'Cursor', '--duration-ms', '150', '--interval-ms', '100', '--json'], deps(runner))).toBe(1);
  expect(events()[0]).toMatchObject({ outcome: 'failed', cycles: 1, lastObservedState: null });
  expect(runner).toHaveBeenCalledTimes(2);
});
