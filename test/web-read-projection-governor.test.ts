/**
 * Read-projection governor (RQ-PHANTOM-VERSE-CPU-1).
 *
 * The installed Verse server burned ~2 cores at idle: the desktop's SSE and
 * polls asked the read worker for a dashboard snapshot that took longer than
 * the worker's 60 s timeout, so every tick restarted a build that could never
 * finish. These tests pin the governor that bounds that work: cost-scaled
 * freshness, stale-while-revalidate, failure backoff, invalidation, and an
 * idle-CPU budget for a client that never stops polling.
 */
import { describe, expect, it } from 'vitest';
import { ReadProjectionError } from '../src/core/web/bounded-read-worker.js';
import { governReadProjections } from '../src/core/web/read-projection-governor.js';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';

/** Fake reader on a manual clock: each build "costs" `cost()` ms of clock time. */
function fakeReader(clock: { t: number }, options: { cost: () => number; fail?: () => Error | null }) {
  const calls: string[] = [];
  let busyMs = 0;
  let value = 0;
  let invalidations = 0;
  const reader: ReadProjectionReader = {
    read: (async (kind: string) => {
      calls.push(kind);
      const cost = options.cost();
      busyMs += cost;
      clock.t += cost;
      const error = options.fail?.() ?? null;
      if (error) throw error;
      return { kind, value: ++value };
    }) as ReadProjectionReader['read'],
    invalidate: async () => { invalidations++; },
    close: async () => {},
  };
  return { reader, calls, busy: () => busyMs, invalidations: () => invalidations };
}

describe('read projection governor', () => {
  it('keeps a build fresh for a multiple of its own cost, then rebuilds', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 100 });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });

    const first = await governed.read('control');
    expect(fake.calls).toHaveLength(1);
    clock.t += 899; // fresh for 9 × 100 ms after the build finished
    expect(await governed.read('control')).toBe(first);
    expect(fake.calls).toHaveLength(1);
    clock.t += 2;
    const second = await governed.read('control');
    expect(fake.calls).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(governed.stats()).toMatchObject({ builds: 2, fresh: 1 });
  });

  it('charges a build only from when it starts executing, not while queued behind another', async () => {
    const clock = { t: 0 };
    const releases: Array<() => void> = [];
    const reader: ReadProjectionReader = {
      read: (async (kind: string) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { kind };
      }) as ReadProjectionReader['read'],
      invalidate: async () => {},
      close: async () => {},
    };
    const governed = governReadProjections(reader, { now: () => clock.t });
    const slow = governed.read('snapshot');
    const cheap = governed.read('pending-count'); // queued behind the snapshot
    clock.t += 60_000;
    releases[0]!();
    await slow;
    clock.t += 10; // the cheap build itself takes 10 ms
    releases[1]!();
    await cheap;
    // Fresh for 9 × 10 ms, not 9 × 60 s: the next read 100 ms later rebuilds.
    clock.t += 100;
    const again = governed.read('pending-count');
    expect(releases).toHaveLength(3);
    releases[2]!();
    await again;
  });

  it('keys by payload so different pulse windows never share a value', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 10 });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    await governed.read('pulse', { window: '1d' });
    await governed.read('pulse', { window: '7d' });
    await governed.read('pulse', { window: '1d' });
    expect(fake.calls).toEqual(['pulse', 'pulse']);
  });

  it('serves an expensive projection stale while its refresh runs', async () => {
    const clock = { t: 0 };
    let release!: () => void;
    let gate: Promise<void> | null = null;
    let value = 0;
    let builds = 0;
    const reader: ReadProjectionReader = {
      read: (async () => {
        builds++;
        clock.t += 5_000;
        if (gate) await gate;
        return { value: ++value };
      }) as ReadProjectionReader['read'],
      invalidate: async () => {},
      close: async () => {},
    };
    const governed = governReadProjections(reader, { now: () => clock.t });
    const first = await governed.read('snapshot');
    clock.t += 60_000; // past the 45 s fresh window
    gate = new Promise<void>((resolve) => { release = resolve; });
    // The request is answered at once from the previous build...
    expect(await governed.read('snapshot')).toBe(first);
    expect(await governed.read('snapshot')).toBe(first);
    expect(builds).toBe(2); // ...and only ONE refresh runs behind it.
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await governed.read('snapshot')).toEqual({ value: 2 });
  });

  it('cheap projections still wait for a fresh build instead of serving stale', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 5 });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    await governed.read('pending-count');
    clock.t += 1_000;
    expect(await governed.read('pending-count')).toEqual({ kind: 'pending-count', value: 2 });
    expect(governed.stats().stale).toBe(0);
  });

  it('backs off exponentially after failures instead of rebuilding on every poll', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, {
      cost: () => 10,
      fail: () => new ReadProjectionError('Read projection timed out', 'READ_PROJECTION_TIMEOUT'),
    });
    const governed = governReadProjections(fake.reader, { now: () => clock.t, failureBackoffMs: 15_000, maxFailureBackoffMs: 120_000 });

    await expect(governed.read('snapshot')).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
    // Inside the 15 s backoff: a fast rejection with the same code, no build.
    clock.t += 14_999;
    await expect(governed.read('snapshot')).rejects.toMatchObject({ code: 'READ_PROJECTION_TIMEOUT' });
    expect(fake.calls).toHaveLength(1);
    clock.t += 1;
    await expect(governed.read('snapshot')).rejects.toThrow();
    expect(fake.calls).toHaveLength(2);
    // Second failure doubles the wait to 30 s.
    clock.t += 29_999;
    await expect(governed.read('snapshot')).rejects.toThrow();
    expect(fake.calls).toHaveLength(2);
    expect(governed.stats().backoffRejections).toBe(2);
  });

  it('holds a slow failure to the same cost multiple as a slow success', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, {
      cost: () => 60_000,
      fail: () => new ReadProjectionError('Read projection timed out', 'READ_PROJECTION_TIMEOUT'),
    });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    await expect(governed.read('snapshot')).rejects.toThrow();
    clock.t += 9 * 60_000 - 1; // 9 × the 60 s it burned, not the 15 s base
    await expect(governed.read('snapshot')).rejects.toThrow();
    expect(fake.calls).toHaveLength(1);
    clock.t += 1;
    await expect(governed.read('snapshot')).rejects.toThrow();
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps serving the last good value while a failing refresh backs off', async () => {
    const clock = { t: 0 };
    let failing = false;
    const fake = fakeReader(clock, { cost: () => 2_000, fail: () => (failing ? new ReadProjectionError('down') : null) });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    const good = await governed.read('fleet-activity');
    failing = true;
    clock.t += 60_000;
    expect(await governed.read('fleet-activity')).toBe(good); // stale; refresh fails behind it
    await new Promise((resolve) => setImmediate(resolve));
    expect(await governed.read('fleet-activity')).toBe(good); // backing off: no new build
    expect(fake.calls).toHaveLength(2);
  });

  it('never backs off on invalid requests or a closed reader', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, {
      cost: () => 1,
      fail: () => new ReadProjectionError('bad', 'READ_PROJECTION_INVALID_REQUEST'),
    });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    await expect(governed.read('runs')).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
    await expect(governed.read('runs')).rejects.toMatchObject({ code: 'READ_PROJECTION_INVALID_REQUEST' });
    expect(fake.calls).toHaveLength(2);
  });

  it('invalidate drops cached values and backoff, and a build started before it cannot repopulate', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 10_000 });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    await governed.read('proposals');
    await governed.invalidate();
    expect(fake.invalidations()).toBe(1);
    expect(await governed.read('proposals')).toEqual({ kind: 'proposals', value: 2 });

    // A build in flight across an invalidation is returned to its waiter but never cached.
    let release!: () => void;
    const slow: ReadProjectionReader = {
      read: (async () => { await new Promise<void>((resolve) => { release = resolve; }); return { stale: true }; }) as ReadProjectionReader['read'],
      invalidate: async () => {},
      close: async () => {},
    };
    let builds = 0;
    const counting: ReadProjectionReader = { ...slow, read: ((...args: Parameters<ReadProjectionReader['read']>) => { builds++; return slow.read(...args); }) as ReadProjectionReader['read'] };
    const g2 = governReadProjections(counting, { now: () => clock.t });
    const pending = g2.read('control');
    await new Promise((resolve) => setImmediate(resolve));
    await g2.invalidate();
    release();
    await pending;
    const next = g2.read('control');
    await new Promise((resolve) => setImmediate(resolve));
    expect(builds).toBe(2);
    release();
    await next;
  });

  it('bounds distinct entries', async () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 10 });
    const governed = governReadProjections(fake.reader, { now: () => clock.t, maxEntries: 2 });
    await governed.read('pulse', { window: '1d' });
    await governed.read('pulse', { window: '7d' });
    await governed.read('pulse', { window: '30d' });
    await governed.read('pulse', { window: '1d' }); // evicted → rebuilt
    expect(fake.calls).toHaveLength(4);
  });

  it('rejects nonsensical options', () => {
    const clock = { t: 0 };
    const fake = fakeReader(clock, { cost: () => 1 });
    expect(() => governReadProjections(fake.reader, { costMultiplier: -1 })).toThrow(RangeError);
    expect(() => governReadProjections(fake.reader, { maxFreshMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('idle CPU budget for a client that never stops polling', () => {
  /**
   * The desktop's /api/events stream ticks every 1.5 s for as long as the app
   * is open. Simulate an hour of it against the projections that pinned the
   * installed server, with their measured costs, and require the worker to
   * stay under 15 % of one core — including the case that caused the
   * incident: a snapshot that always exceeds the 60 s worker timeout.
   */
  function simulateHour(options: { cost: number; fails: boolean }) {
    const clock = { t: 0 };
    const fake = fakeReader(clock, {
      cost: () => options.cost,
      fail: () => (options.fails ? new ReadProjectionError('Read projection timed out', 'READ_PROJECTION_TIMEOUT') : null),
    });
    const governed = governReadProjections(fake.reader, { now: () => clock.t });
    return (async () => {
      const hour = 60 * 60_000;
      while (clock.t < hour) {
        try { await governed.read('snapshot'); } catch { /* the SSE tick survives a failed read */ }
        clock.t += 1_500;
      }
      return { duty: fake.busy() / clock.t, builds: fake.calls.length };
    })();
  }

  it.each([
    { name: 'snapshot that always times out at 60 s', cost: 60_000, fails: true },
    { name: 'snapshot that succeeds in 65 s', cost: 65_000, fails: false },
    { name: 'control projection at 18 s', cost: 18_000, fails: false },
    { name: 'cheap projection at 40 ms', cost: 40, fails: false },
  ])('$name stays under 15 % of one core', async ({ cost, fails }) => {
    const { duty } = await simulateHour({ cost, fails });
    expect(duty).toBeLessThan(0.15);
  });

  it('real CPU: a governed busy projection polled continuously stays under budget', async () => {
    // A projection that really burns CPU on this thread for ~40 ms per build.
    const burn = (ms: number): void => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
    let value = 0;
    const busyReader: ReadProjectionReader = {
      read: (async () => { burn(40); return { value: ++value }; }) as ReadProjectionReader['read'],
      invalidate: async () => {},
      close: async () => {},
    };
    async function measure(reader: ReadProjectionReader, durationMs: number): Promise<number> {
      const startCpu = process.cpuUsage();
      const start = performance.now();
      while (performance.now() - start < durationMs) {
        await reader.read('control');
        await new Promise((resolve) => setTimeout(resolve, 5)); // a 5 ms poller
      }
      const used = process.cpuUsage(startCpu);
      return (used.user + used.system) / 1_000 / (performance.now() - start);
    }
    const governed = await measure(governReadProjections(busyReader), 1_500);
    // Without the governor the same poller keeps the thread busy (~90 % on an
    // idle machine). Comparing against it, rather than a fixed number, proves
    // the budget assertion measures the right thing even on a loaded CI host.
    const ungoverned = await measure(busyReader, 600);
    expect(governed).toBeLessThan(0.3);
    expect(governed).toBeLessThan(ungoverned * 0.4);
  });
});
