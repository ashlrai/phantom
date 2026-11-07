import { afterEach, expect, it, vi } from 'vitest';
import { withMirrorRepoDeadline } from '../src/core/fleet/mirrors.js';
afterEach(() => vi.useRealTimers());
it('cancels a stuck repo at its deadline even if it never settles, then admits the next repo', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const stuck = withMirrorRepoDeadline(s => { signal = s; return new Promise(() => undefined); },
    new AbortController().signal, 1000);
  const rejection = expect(stuck).rejects.toThrow('mirror prep timed out after 1 s; repo skipped');
  await vi.advanceTimersByTimeAsync(1000);
  await rejection;
  expect(signal.aborted).toBe(true);
  await expect(withMirrorRepoDeadline(async () => 'next repo ready', new AbortController().signal)).resolves.toBe('next repo ready');
  expect(vi.getTimerCount()).toBe(0);
});
it('forwards shutdown cancellation and clears the repo timer after settling', async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const sync = withMirrorRepoDeadline(signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
  }), parent.signal);
  parent.abort();
  await expect(sync).resolves.toBe('cancelled');
  expect(vi.getTimerCount()).toBe(0);
});
