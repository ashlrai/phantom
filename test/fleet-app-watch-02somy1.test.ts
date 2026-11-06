import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppWatch } from '../src/cli/fleet-app-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const success = (outcome = 'running', app = 'Cursor') => ({ code: 0, stdout: JSON.stringify({ app, outcome, running: true }) });
const report = () => JSON.parse(output.trim());
beforeEach(() => {
  output = '';
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('app-watch', () => {
  it('supervises sequentially and counts a later recovery', async () => {
    let clock = 0, active = 0;
    const runner = vi.fn<AppsEnsureChildRunner>(async () => {
      active++;
      expect(active).toBe(1);
      const result = success(active && runner.mock.calls.length === 3 ? 'launched' : 'running');
      active--;
      return result;
    });
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    expect(await cmdFleetAppWatch(['Cursor', '--duration-ms', '300', '--interval-ms', '100', '--root', '/runs', '--json'], { runChild: runner, now: () => clock, sleep })).toBe(0);
    expect(runner.mock.calls.map(([args]) => args)).toEqual([300, 200, 100].map(n => ['fleet', 'app-ensure', 'Cursor', '--timeout-ms', String(n), '--root', '/runs', '--json']));
    expect(report()).toMatchObject({ outcome: 'completed', checks: 3, recoveries: 1, lastObservedState: 'running' });
  });
  it.each([
    { code: 0, stdout: 'private output' },
    success('unknown'), success('launched', 'Claude'),
    { code: 1, stdout: JSON.stringify({ app: 'Cursor', outcome: 'launched', running: true }) },
  ])('fails closed on an invalid child result', async result => {
    const runner = vi.fn<AppsEnsureChildRunner>(async () => result);
    expect(await cmdFleetAppWatch(['Cursor', '--duration-ms', '1000', '--json'], { runChild: runner })).toBe(1);
    expect(report()).toMatchObject({ outcome: 'failed', recoveries: 0, lastObservedState: null });
    expect(output).not.toContain('private output');
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.each([[], ['Cursor'], ['Cursor', 'Claude', '--duration-ms', '100'], ['Cursor', '--duration-ms', '0'], ['Cursor', '--duration-ms', '100', '--interval-ms', '99']])('rejects invalid arguments before work', async (...args) => {
    const runner = vi.fn<AppsEnsureChildRunner>();
    expect(await cmdFleetAppWatch(args as string[], { runChild: runner })).toBe(2);
    expect(runner).not.toHaveBeenCalled();
  });
  it('handles pre-abort and abort during a child without accepting late success', async () => {
    const controller = new AbortController();
    let finish!: (value: ReturnType<typeof success>) => void;
    let childSignal: AbortSignal | undefined;
    const runner = vi.fn<AppsEnsureChildRunner>((_, options) => { childSignal = options.signal; return new Promise(resolve => { finish = resolve; }); });
    controller.abort();
    expect(await cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    output = '';
    const next = new AbortController();
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--json'], { runChild: runner, signal: next.signal });
    await Promise.resolve();
    next.abort();
    expect(await pending).toBe(1);
    expect(childSignal?.aborted).toBe(true);
    finish(success('launched'));
    await Promise.resolve();
    expect(report()).toMatchObject({ outcome: 'cancelled', recoveries: 0, lastObservedState: null });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.each(['child', 'sleep'] as const)('expires during uncooperative %s and ignores late completion', async stage => {
    let finish!: (value: ReturnType<typeof success>) => void;
    let finishSleep!: () => void;
    const runner = vi.fn<AppsEnsureChildRunner>(() => stage === 'child' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(success()));
    const sleep = vi.fn(() => new Promise<void>(resolve => { finishSleep = resolve; }));
    const pending = cmdFleetAppWatch(['Cursor', '--duration-ms', '100', '--json'], { runChild: runner, sleep });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(0);
    if (stage === 'child') finish(success('launched')); else finishSleep();
    await Promise.resolve();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(report()).toMatchObject({ outcome: 'completed', recoveries: 0, lastObservedState: stage === 'child' ? null : 'running' });
  });
});
