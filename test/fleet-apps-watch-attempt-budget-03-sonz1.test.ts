import { stat } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, stat: vi.fn(original.stat) };
});

let output = '';
const events = () => output.trim().split('\n').map(line => JSON.parse(line));
const healthy = { code: 0, stdout: JSON.stringify({ ok: true, apps: [{ app: 'Phantom', observedRunning: true }] }) };
const args = ['Phantom', '--duration-ms', '1000', '--interval-ms', '100', '--attempt-timeout-ms', '200', '--max-consecutive-failures', '2', '--jsonl'];
beforeEach(() => {
  vi.useFakeTimers(); output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const abortable: AppsEnsureChildRunner = async (_argv, options) => new Promise(resolve => {
  options.signal?.addEventListener('abort', () => resolve(healthy), { once: true });
});

it.each([[[]], [['0']], [['300001']], [['1.5']], [['no']], [['-1']], [['1', '--attempt-timeout-ms', '2']]])('rejects invalid attempt timeout %j without launching', async values => {
  const runChild = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--attempt-timeout-ms', ...values], { runChild })).toBe(2);
  expect(runChild).not.toHaveBeenCalled();
});

it('records timeout, retries after settlement, and resets the streak on success', async () => {
  const controller = new AbortController();
  const runChild = vi.fn<AppsEnsureChildRunner>().mockImplementationOnce(abortable).mockImplementationOnce(async () => healthy);
  const watch = cmdFleetAppsWatch(args, { runChild, signal: controller.signal, sleep: async (_ms, signal) => { if (runChild.mock.calls.length === 2) controller.abort(); else await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }); } });
  await vi.advanceTimersByTimeAsync(301);
  expect(await watch).toBe(1);
  expect(events()[0]).toMatchObject({ healthy: false, consecutiveFailures: 1, observedState: [{ app: 'Phantom', observedRunning: null }], diagnostics: [{ outcome: 'timeout', reason: 'deadline' }] });
  expect(events()[1]).toMatchObject({ healthy: true, consecutiveFailures: 0, totalFailedCycles: 1 });
  expect(runChild).toHaveBeenCalledTimes(2);
  expect(runChild.mock.calls[0]![0]).toContain('200');
  expect(runChild.mock.calls[0]![1].timeoutMs).toBe(200);
});

it('stops at the timeout failure streak limit', async () => {
  const runChild = vi.fn<AppsEnsureChildRunner>(abortable);
  const watch = cmdFleetAppsWatch(args, { runChild });
  await vi.advanceTimersByTimeAsync(501);
  expect(await watch).toBe(1);
  expect(events().at(-1)).toMatchObject({ outcome: 'failed', cycles: 2, consecutiveFailures: 2 });
});

it('clamps the attempt to remaining duration and preserves legacy timeout when omitted', async () => {
  for (const extra of [['--attempt-timeout-ms', '500'], []]) {
    let clock = 0;
    const runChild = vi.fn<AppsEnsureChildRunner>(async () => healthy);
    const watch = cmdFleetAppsWatch(['Phantom', '--duration-ms', '150', '--interval-ms', '100', ...extra, '--jsonl'], { runChild, now: () => clock, sleep: async ms => { clock += ms; } });
    expect(await watch).toBe(0);
    expect(runChild.mock.calls.map(call => call[1].timeoutMs)).toEqual([150, 50]);
    expect(runChild.mock.calls[1]![0].slice(-2)).toEqual(['--timeout-ms', '50']);
  }
});

it('does not overlap an abort-ignoring child and terminates at the total deadline', async () => {
  const runChild = vi.fn<AppsEnsureChildRunner>(() => new Promise(() => {}));
  const watch = cmdFleetAppsWatch(args, { runChild });
  await vi.advanceTimersByTimeAsync(1001);
  expect(await watch).toBe(1);
  expect(runChild).toHaveBeenCalledTimes(1);
  expect(events().at(-1)).toMatchObject({ outcome: 'failed', cycles: 1 });
});

it('cancellation during an attempt prevents retry', async () => {
  const controller = new AbortController();
  const runChild = vi.fn<AppsEnsureChildRunner>(abortable);
  const watch = cmdFleetAppsWatch(args, { runChild, signal: controller.signal });
  await vi.advanceTimersByTimeAsync(50); controller.abort();
  expect(await watch).toBe(1);
  expect(runChild).toHaveBeenCalledTimes(1);
  expect(events().at(-1)).toMatchObject({ outcome: 'cancelled', cycles: 0 });
});

it('stop-file during an attempt aborts the child and prevents retry', async () => {
  vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })).mockResolvedValue({} as never);
  const runChild = vi.fn<AppsEnsureChildRunner>(abortable);
  const watch = cmdFleetAppsWatch([...args, '--stop-file', '/fake/stop'], { runChild });
  await vi.advanceTimersByTimeAsync(101);
  expect(await watch).toBe(1);
  expect(runChild).toHaveBeenCalledTimes(1);
  expect(events().at(-1)).toMatchObject({ outcome: 'cancelled', cycles: 0 });
});
