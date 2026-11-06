import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsEnsure, type AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const success = (app: string) => ({ code: 0, stdout: JSON.stringify({ app, outcome: 'running', running: true, launched: false }) });
const aggregate = () => {
  const lines = output.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
};

beforeEach(() => {
  output = '';
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('grouped app recovery cancellation', () => {
  it('settles a nonresponsive child immediately and preserves completed observations', async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const runner = vi.fn<AppsEnsureChildRunner>((args, options) => {
      childSignal = options.signal;
      return args[2] === 'Cursor' ? Promise.resolve(success('Cursor')) : new Promise(() => {});
    });
    const pending = cmdFleetAppsEnsure(['Cursor', 'Claude', 'Codex', '--json'], { runChild: runner, signal: controller.signal });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await pending).toBe(1);
    expect(childSignal?.aborted).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(aggregate()).toMatchObject({ ok: false, endedBy: 'cancelled', apps: [
      { app: 'Cursor', attempted: true, observedRunning: true },
      { app: 'Claude', attempted: true, outcome: 'cancelled', observedRunning: false },
      { app: 'Codex', attempted: false, outcome: 'unattempted', reason: 'cancelled' },
    ] });
  });

  it('does not execute a child for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn<AppsEnsureChildRunner>();
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(aggregate()).toMatchObject({ endedBy: 'cancelled', apps: [
      { attempted: false, reason: 'cancelled' }, { attempted: false, reason: 'cancelled' },
    ] });
  });

  it('does not start a child if cancellation happens during listener registration', async () => {
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
      controller.abort();
      add(...args);
    });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const runner = vi.fn<AppsEnsureChildRunner>();
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(aggregate()).toMatchObject({ endedBy: 'cancelled', apps: [
      { attempted: false, reason: 'cancelled' }, { attempted: false, reason: 'cancelled' },
    ] });
  });

  it.each(['fulfill', 'reject'] as const)('ignores a late child %s', async (settlement) => {
    const controller = new AbortController();
    let resolve!: (value: ReturnType<typeof success>) => void;
    let reject!: (reason: Error) => void;
    const runner = vi.fn<AppsEnsureChildRunner>(() => new Promise((res, rej) => { resolve = res; reject = rej; }));
    const pending = cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner, signal: controller.signal });
    controller.abort();
    expect(await pending).toBe(1);
    const emitted = output;
    if (settlement === 'fulfill') resolve(success('Cursor'));
    else reject(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(output).toBe(emitted);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(aggregate()).toMatchObject({ ok: false, endedBy: 'cancelled', apps: [
      { outcome: 'cancelled', observedRunning: false }, { attempted: false, reason: 'cancelled' },
    ] });
  });

  it('gives cancellation priority when a child succeeds before the race resumes', async () => {
    const controller = new AbortController();
    const runner: AppsEnsureChildRunner = async () => { controller.abort(); return success('Cursor'); };
    expect(await cmdFleetAppsEnsure(['Cursor', '--json'], { runChild: runner, signal: controller.signal })).toBe(1);
    expect(aggregate()).toMatchObject({ endedBy: 'cancelled', apps: [{ outcome: 'cancelled', observedRunning: false }] });
  });

  it('keeps normal success and deadline behavior', async () => {
    const runner = vi.fn<AppsEnsureChildRunner>(async args => success(args[2]!));
    expect(await cmdFleetAppsEnsure(['Cursor', 'Claude', '--json'], { runChild: runner })).toBe(0);
    expect(aggregate()).toMatchObject({ ok: true, endedBy: 'complete' });
    output = '';
    const pending = cmdFleetAppsEnsure(['Cursor', 'Claude', '--timeout-ms', '100', '--json'], { runChild: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe(1);
    expect(aggregate()).toMatchObject({ endedBy: 'deadline', apps: [
      { attempted: true, outcome: 'timeout' }, { attempted: false, reason: 'deadline' },
    ] });
  });
});
