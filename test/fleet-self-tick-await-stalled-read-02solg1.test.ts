import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitSelfTick } from '../src/core/fleet/self-tick-await.js';
import type { SelfTickLastView } from '../src/core/fleet/self-tick-last.js';

const start = Date.parse('2026-11-01T18:06:00.000Z');
const options = { runsDir: '/fake', afterMs: start - 1, timeoutMs: 1000, intervalMs: 100 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); });

describe('self-tick await pending reads', () => {
  it('times out one stalled read and safely observes its late rejection', async () => {
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(() => new Promise<SelfTickLastView | null>((_resolve, reject) => { rejectRead = reject; }));
    const result = awaitSelfTick({ ...options, read });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ outcome: 'timed-out', exitCode: 3, polls: 1, lastObservation: null });
    rejectRead(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('interrupts a stalled read promptly', async () => {
    const controller = new AbortController();
    const read = vi.fn(() => new Promise<SelfTickLastView | null>(() => {}));
    const result = awaitSelfTick({ ...options, read, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await result).toMatchObject({ outcome: 'interrupted', exitCode: 130, polls: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([['succeeded', [], 0], ['failed', ['planner-tick'], 1]] as const)(
    'preserves a fresh %s apply record', async (outcome, failedSteps, exitCode) => {
      const read = vi.fn(async (): Promise<SelfTickLastView> => ({ state: 'ok', at: new Date(start).toISOString(),
        mode: 'apply', ranState: 'ran', ageSeconds: 0, failedSteps: [...failedSteps] }));
      expect(await awaitSelfTick({ ...options, read })).toMatchObject({ outcome, exitCode, polls: 1,
        lastObservation: { state: 'seen', failedSteps: [...failedSteps] } });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
