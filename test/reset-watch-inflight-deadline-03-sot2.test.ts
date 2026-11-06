import { afterEach, expect, it, vi } from 'vitest';
import { watchResetReleases, type ResetWatchRecord } from '../src/core/fleet/reset-release-watch.js';
import type { ResetReleaseResult } from '../src/core/fleet/usage-reset-release.js';

const pass: ResetReleaseResult = { at: '2026-11-01T18:06:00Z', checked: 1, released: [
  { lane: 'fake', state: 'reset-detected', usedPct: 0, readingAsOf: null, heldUntil: null },
], bus: [], errors: [] };
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => { vi.useRealTimers(); });

it('returns at the deadline with an unresolved pass, ignoring its late success', async () => {
  vi.useFakeTimers();
  const pending = deferred<ResetReleaseResult>(), records: ResetWatchRecord[] = [];
  const run = vi.fn(() => pending.promise);
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const watching = watchResetReleases({ timeoutMs: 100 }, { run, emit: r => { records.push(r); } });
  await vi.advanceTimersByTimeAsync(100);
  const result = await watching;
  expect(result).toEqual({ outcome: 'deadline', passes: 0, released: 0, errors: 0, lastError: null, inFlight: true });
  expect(run).toHaveBeenCalledTimes(1);
  expect(records).toEqual([{ v: 1, type: 'end', ...result }]);
  pending.resolve(pass);
  await Promise.resolve();
  expect(result.passes).toBe(0);
  expect(records).toHaveLength(1);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('observes a late rejection after cancellation during a pass', async () => {
  vi.useFakeTimers();
  const pending = deferred<ResetReleaseResult>(), controller = new AbortController();
  const watching = watchResetReleases({ timeoutMs: 100, signal: controller.signal }, { run: () => pending.promise });
  await Promise.resolve();
  controller.abort();
  expect(await watching).toMatchObject({ outcome: 'cancelled', passes: 0, inFlight: true });
  pending.reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['deadline', 'cancelled'] as const)('interrupts a stuck pass output on %s', async reason => {
  vi.useFakeTimers();
  const controller = new AbortController(), pending = deferred<void>(), records: ResetWatchRecord[] = [];
  const run = vi.fn(async () => pass);
  const watching = watchResetReleases({ timeoutMs: 100, signal: controller.signal }, {
    run, emit: r => { records.push(r); if (r.type === 'pass') return pending.promise; },
  });
  await vi.advanceTimersByTimeAsync(0);
  if (reason === 'deadline') await vi.advanceTimersByTimeAsync(100); else controller.abort();
  expect(await watching).toMatchObject({ outcome: reason, passes: 1, released: 1 });
  pending.reject(new Error('late sink failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  expect(records.map(r => r.type)).toEqual(['pass', 'end']);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a stuck terminal output after an early failure', async () => {
  vi.useFakeTimers();
  const watching = watchResetReleases({ timeoutMs: 100 }, {
    run: async () => { throw new Error('failed pass'); }, emit: () => new Promise<void>(() => {}),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await watching).toMatchObject({ outcome: 'failed', lastError: 'failed pass' });
  expect(vi.getTimerCount()).toBe(0);
});
