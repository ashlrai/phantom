import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRetroSweepTimer, type RetroSweepTimerDeps } from '../src/core/learn/retro/sweep-timer.js';

function harness(overrides: Partial<RetroSweepTimerDeps> = {}) {
  return {
    now: () => Date.now(),
    lastSweptAt: async () => null,
    inFlight: async () => false,
    sweep: vi.fn(async () => undefined),
    nightly: vi.fn(async () => ({ status: 'completed' as const, jobs: 0, reviews: 0, proposals: 0 })),
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer: (h: { unref?(): unknown }) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...overrides,
  };
}

describe('nightly retro timer integration', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['recent', 'busy'])('runs the independent nightly check when hourly is %s', async (reason) => {
    const deps = harness({
      lastSweptAt: async () => reason === 'recent' ? new Date().toISOString() : null,
      inFlight: async () => reason === 'busy',
    });
    const timer = startRetroSweepTimer(deps, { firstDelayMs: 100, intervalMs: 1_000 });
    expect(deps.nightly).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(deps.nightly).toHaveBeenCalledTimes(1);
    expect(deps.sweep).not.toHaveBeenCalled();
    await timer.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues hourly learning after an unavailable nightly source and retries next tick', async () => {
    const deps = harness({ nightly: vi.fn(async () => { throw new Error('source unavailable'); }) });
    const onNightly = vi.fn();
    const timer = startRetroSweepTimer(deps, { firstDelayMs: 100, intervalMs: 1_000, onNightly });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(deps.nightly).toHaveBeenCalledTimes(2);
    expect(deps.sweep).toHaveBeenCalledTimes(2);
    expect(onNightly).toHaveBeenLastCalledWith({ status: 'unavailable', jobs: 0, reviews: 0, proposals: 0 });
    await timer.stop();
  });

  it('waits for nightly work on shutdown without starting hourly work afterward', async () => {
    let release!: () => void;
    const deps = harness({ nightly: vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ status: 'completed', jobs: 0, reviews: 0, proposals: 0 });
    })) });
    const timer = startRetroSweepTimer(deps, { firstDelayMs: 100, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(timer.running).toBe(true);
    expect(deps.nightly).toHaveBeenCalledTimes(1);
    const stopped = timer.stop();
    release();
    await stopped;
    expect(deps.sweep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
