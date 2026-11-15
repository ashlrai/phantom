import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortableSleep, boundedAwait, isAwaitMs, wireAwaitCancel,
} from '../src/core/util/await-support.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('isAwaitMs', () => {
  it.each([1, 250, 1_000])('accepts a positive safe integer under the cap: %s', value => {
    expect(isAwaitMs(value, 1_000)).toBe(true);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1_001, '100', null, undefined])('rejects %s', value => {
    expect(isAwaitMs(value, 1_000)).toBe(false);
  });
});

describe('abortableSleep', () => {
  it('resolves after the requested time and keeps no timer', async () => {
    let done = false;
    const pending = abortableSleep(100).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves early on abort and never rejects', async () => {
    const controller = new AbortController();
    const pending = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately against a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('wireAwaitCancel', () => {
  it('aborts the controller on SIGINT, SIGTERM and the caller signal, then detaches cleanly', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const first = new AbortController();
    const detachFirst = wireAwaitCancel(first);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')])
      .toEqual([before[0]! + 1, before[1]! + 1]);
    process.emit('SIGINT');
    expect(first.signal.aborted).toBe(true);
    detachFirst();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);

    const caller = new AbortController();
    const second = new AbortController();
    const detachSecond = wireAwaitCancel(second, caller.signal);
    caller.abort();
    expect(second.signal.aborted).toBe(true);
    detachSecond();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('aborts at once against a pre-aborted caller signal', () => {
    const caller = new AbortController();
    caller.abort();
    const controller = new AbortController();
    const detach = wireAwaitCancel(controller, caller.signal);
    expect(controller.signal.aborted).toBe(true);
    detach();
  });
});

describe('boundedAwait', () => {
  const neverAbort = new AbortController().signal;

  it('returns the operation value', async () => {
    const raced = await boundedAwait(async () => 42,
      { cancel: neverAbort, deadlineMs: 1_000, now: () => 0 });
    expect(raced).toEqual({ kind: 'value', value: 42 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports deadline when the operation outlives the bound and absorbs its late settle', async () => {
    let resolveLate!: (value: string) => void;
    const raced = boundedAwait(() => new Promise<string>(resolve => { resolveLate = resolve; }),
      { cancel: neverAbort, deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await raced).kind).toBe('deadline');
    resolveLate('late');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports cancelled on a pre-aborted and a mid-flight abort', async () => {
    const pre = new AbortController();
    pre.abort();
    expect((await boundedAwait(async () => 1,
      { cancel: pre.signal, deadlineMs: 1_000 })).kind).toBe('cancelled');

    const mid = new AbortController();
    const raced = boundedAwait(() => new Promise<number>(() => {}),
      { cancel: mid.signal, deadlineMs: 60_000 });
    mid.abort();
    expect((await raced).kind).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports failed with the real error on rejection and on a sync throw', async () => {
    const error = new Error('read failed');
    expect(await boundedAwait(async () => { throw error; },
      { cancel: neverAbort, deadlineMs: 1_000 })).toEqual({ kind: 'failed', error });
    expect(await boundedAwait(() => { throw error; },
      { cancel: neverAbort, deadlineMs: 1_000 })).toEqual({ kind: 'failed', error });
  });

  it('reports failed when the monitor sleep rejects', async () => {
    const error = new Error('nap');
    const raced = boundedAwait(() => new Promise<number>(() => {}),
      { cancel: neverAbort, deadlineMs: 1_000, sleep: async () => { throw error; } });
    expect(await raced).toEqual({ kind: 'failed', error });
  });

  it('polls the watch every slice and reports its stop', async () => {
    let t = 0;
    let probes = 0;
    const sleep = vi.fn(async (ms: number) => { t += ms; });
    const raced = boundedAwait(() => new Promise<number>(() => {}), {
      cancel: neverAbort, deadlineMs: 1_000, now: () => t, sleep,
      watch: () => { probes += 1; return probes === 3 ? 'cancelled' : undefined; }, watchSliceMs: 250,
    });
    expect(await raced).toEqual({ kind: 'cancelled' });
    expect(probes).toBe(3);
    expect(sleep).toHaveBeenCalledWith(250, expect.any(AbortSignal));
  });

  it('enforces the deadline between watch probes', async () => {
    let t = 0;
    const sleep = async (ms: number): Promise<void> => { t += ms; };
    const raced = await boundedAwait(() => new Promise<number>(() => {}), {
      cancel: neverAbort, deadlineMs: 600, now: () => t, sleep, watch: () => undefined, watchSliceMs: 250,
    });
    expect(raced).toEqual({ kind: 'deadline' });
    expect(t).toBe(600); // slices of min(250, remaining): 250 + 250 + 100
  });

  it('reports a watch failure with its error', async () => {
    const error = new Error('probe died');
    let t = 0;
    const raced = await boundedAwait(() => new Promise<number>(() => {}), {
      cancel: neverAbort, deadlineMs: 1_000, now: () => t,
      sleep: async (ms) => { t += ms; },
      watch: () => { throw error; }, watchSliceMs: 250,
    });
    expect(raced).toEqual({ kind: 'failed', error });
  });

  it('drops the cancel listener once the race settles', async () => {
    const controller = new AbortController();
    const raced = await boundedAwait(async () => 1,
      { cancel: controller.signal, deadlineMs: 1_000 });
    expect(raced).toEqual({ kind: 'value', value: 1 });
    controller.abort(); // must not touch a settled race; detach already ran
    expect(vi.getTimerCount()).toBe(0);
  });
});
