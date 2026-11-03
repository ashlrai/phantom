import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppEnsure } from '../src/cli/fleet-app-ensure.js';

// Fake app-control children only: nothing here launches, quits or restarts a real app.
const SCRIPT = '/fake/app_control.py';
const status = (running: boolean) => ({ stdout: JSON.stringify({ action: 'status', ok: true, code: 'ok', running }), stderr: '' });
const launchOk = { stdout: JSON.stringify({ action: 'launch', ok: true, code: 'launched' }), stderr: '' };

type Reply = { stdout: string; stderr: string } | 'hang';

/** A 'hang' child stays pending until the signal it was given aborts, then rejects the way execFile does on abort. */
const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  if (signal.aborted) fail();
  else signal.addEventListener('abort', fail, { once: true });
});

/** Replies are keyed by action; each action consumes its queue, repeating the last entry. */
function harness(replies: { status: Reply[]; launch?: Reply[] }) {
  let t = 0;
  const used = { status: 0, launch: 0 };
  const exec = vi.fn(async (_file: string, argv: readonly string[], o: { timeout: number; signal: AbortSignal }) => {
    const action = argv[2] as 'status' | 'launch';
    const queue = replies[action] ?? [{ stdout: 'x', stderr: '' }];
    const reply = queue[Math.min(used[action]++, queue.length - 1)]!;
    return reply === 'hang' ? hang(o.signal) : reply;
  });
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  return {
    exec,
    actions: () => exec.mock.calls.map(c => c[1][2]),
    signals: () => exec.mock.calls.map(c => c[2].signal),
    deps: (signal?: AbortSignal) => ({ exec, sleep, now: () => t, locateScript: () => SCRIPT, signal }),
  };
}

let out = '';
beforeEach(() => {
  vi.useFakeTimers();
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out += s; return true; }) as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Lets every microtask-only step (fake children that resolve at once) run up to the next pending child. */
const flush = () => vi.advanceTimersByTimeAsync(0);
const report = () => JSON.parse(out.trim().split('\n').pop()!);

describe('fleet app-ensure reclaims its child when a run stops', () => {
  it('cancel during the initial status aborts the active child and makes no further calls', async () => {
    const h = harness({ status: ['hang'] });
    const ctl = new AbortController();
    const pending = cmdFleetAppEnsure(['Cursor', '--json'], h.deps(ctl.signal));
    await flush();
    expect(h.actions()).toEqual(['status']);
    expect(h.signals()[0]!.aborted).toBe(false);
    ctl.abort();
    expect(await pending).toBe(1);
    expect(h.signals()[0]!.aborted).toBe(true);
    expect(h.actions()).toEqual(['status']);
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: false, running: null });
  });

  it('cancel during the launch aborts that child and never starts confirmation', async () => {
    const h = harness({ status: [status(false)], launch: ['hang'] });
    const ctl = new AbortController();
    const pending = cmdFleetAppEnsure(['Cursor', '--json'], h.deps(ctl.signal));
    await flush();
    expect(h.actions()).toEqual(['status', 'launch']);
    ctl.abort();
    expect(await pending).toBe(1);
    expect(h.signals().map(s => s.aborted)).toEqual([false, true]); // the status child had already settled
    expect(h.actions()).toEqual(['status', 'launch']);
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: true });
  });

  it('cancel during confirmation aborts the probe child and stops polling', async () => {
    const h = harness({ status: [status(false), 'hang'], launch: [launchOk] });
    const ctl = new AbortController();
    const pending = cmdFleetAppEnsure(['Cursor', '--json'], h.deps(ctl.signal));
    await flush();
    expect(h.actions()).toEqual(['status', 'launch', 'status']);
    ctl.abort();
    expect(await pending).toBe(1);
    expect(h.signals()[2]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.actions()).toEqual(['status', 'launch', 'status']);
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: true });
  });

  it('deadline during the initial status aborts the child and reports timeout', async () => {
    const h = harness({ status: ['hang'] });
    const pending = cmdFleetAppEnsure(['Cursor', '--timeout-ms', '50', '--json'], h.deps());
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(1);
    expect(h.signals()[0]!.aborted).toBe(true);
    expect(h.actions()).toEqual(['status']);
    expect(report()).toMatchObject({ outcome: 'timeout', launched: false });
  });

  it('deadline during the launch aborts that child; no confirmation follows', async () => {
    const h = harness({ status: [status(false)], launch: ['hang'] });
    const pending = cmdFleetAppEnsure(['Cursor', '--timeout-ms', '50', '--json'], h.deps());
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(1);
    expect(h.signals().map(s => s.aborted)).toEqual([false, true]); // the status child had already settled
    expect(h.actions()).toEqual(['status', 'launch']);
    expect(report()).toMatchObject({ outcome: 'timeout', launched: true });
  });

  it('deadline during confirmation aborts the probe child and never launches again', async () => {
    const h = harness({ status: [status(false), 'hang'], launch: [launchOk] });
    const pending = cmdFleetAppEnsure(['Cursor', '--timeout-ms', '50', '--json'], h.deps());
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(1);
    expect(h.signals()[2]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.actions()).toEqual(['status', 'launch', 'status']);
    expect(report()).toMatchObject({ outcome: 'timeout', launched: true });
  });

  it('a child that ignores its signal is still settled and aborted at the deadline', async () => {
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => {}));
    const pending = cmdFleetAppEnsure(['Cursor', '--timeout-ms', '50', '--json'], { exec, locateScript: () => SCRIPT });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect((exec.mock.calls[0] as unknown as [string, string[], { signal: AbortSignal }])[2].signal.aborted).toBe(true);
    expect(report()).toMatchObject({ outcome: 'timeout', launched: false, running: null });
  });

  it('a status that lands after cancellation is discarded and never launches', async () => {
    const ctl = new AbortController();
    const exec = vi.fn(async () => {
      ctl.abort();
      return status(false);
    });
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], { exec, locateScript: () => SCRIPT, signal: ctl.signal })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: false });
  });

  it('cancellation during listener registration starts no child', async () => {
    const ctl = new AbortController();
    const add = ctl.signal.addEventListener.bind(ctl.signal);
    vi.spyOn(ctl.signal, 'addEventListener').mockImplementation((...args) => {
      ctl.abort();
      add(...args);
    });
    const h = harness({ status: [status(true)] });
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], h.deps(ctl.signal))).toBe(1);
    expect(h.exec).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: false });
  });

  it('ordinary success leaves no stale abort listener or timer', async () => {
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, 'addEventListener');
    const remove = vi.spyOn(ctl.signal, 'removeEventListener');
    const h = harness({ status: [status(false), status(true)], launch: [launchOk] });
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], h.deps(ctl.signal))).toBe(0);
    expect(report()).toMatchObject({ outcome: 'launched', launched: true, running: true });
    expect(add.mock.calls.length).toBeGreaterThan(0);
    expect(remove.mock.calls.map(c => c[1])).toEqual(add.mock.calls.map(c => c[1]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel during the default confirmation wait clears its sleep timer and stops polling', async () => {
    // No injected sleep or clock: the real default wait runs on the fake timers.
    const ctl = new AbortController();
    const h = harness({ status: [status(false)], launch: [launchOk] });
    const pending = cmdFleetAppEnsure(['Cursor', '--json'], { exec: h.exec, locateScript: () => SCRIPT, signal: ctl.signal });
    await flush();
    expect(h.actions()).toEqual(['status', 'launch', 'status']);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the run deadline and the confirmation wait are pending
    ctl.abort();
    expect(await pending).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.actions()).toEqual(['status', 'launch', 'status']);
    expect(report()).toMatchObject({ outcome: 'cancelled', launched: true });
  });

  it('already-running success leaves no timer behind', async () => {
    const h = harness({ status: [status(true)] });
    expect(await cmdFleetAppEnsure(['Cursor', '--json'], h.deps())).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
