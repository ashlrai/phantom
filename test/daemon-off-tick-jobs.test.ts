import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchOffTickJob, offTickJobsSnapshot, cancelOffTickJobs, resetOffTickJobsForTests } from '../src/core/daemon/off-tick-jobs.js';
import { beginTickPhases, endTickPhases, runTickPhase, skipTickPhase, tickPhasesSnapshot, deriveTickOutcome, resetTickPhasesForTests } from '../src/core/daemon/tick-phases.js';
import { freshDaemonState, saveDaemonState, loadDaemonState } from '../src/core/daemon/state.js';

afterEach(() => {
  resetOffTickJobsForTests();
  resetTickPhasesForTests();
  vi.useRealTimers();
});

describe('resident off-tick jobs', () => {
  it('records launches and single-flight running metadata, then previous ok result', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    beginTickPhases();
    const first = launchOffTickJob('heal', run, { deadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toMatchObject({ status: 'off-tick', durationMs: 0, offTick: { state: 'started', run: 1 } });
    expect(launchOffTickJob('heal', run, { deadlineMs: 100 }).offTick?.state).toBe('running');
    expect(run).toHaveBeenCalledTimes(1);
    expect(endTickPhases()).toHaveLength(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(launchOffTickJob('heal', async () => undefined, { deadlineMs: 100 }).offTick).toMatchObject({ run: 2, lastStatus: 'ok', lastDurationMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('does not stack timed-out inner work, observes late rejection and reports timeout history', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    const run = vi.fn((s: AbortSignal) => { signal = s; return new Promise<void>((_resolve, fail) => { reject = fail; }); });
    const log = vi.fn();
    launchOffTickJob('slow', run, { deadlineMs: 5, graceMs: 1, log });
    await vi.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(true);
    expect(offTickJobsSnapshot()[0]?.running).toBe(true);
    expect(launchOffTickJob('slow', run, { deadlineMs: 5 }).offTick?.state).toBe('running');
    expect(run).toHaveBeenCalledTimes(1);
    reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(offTickJobsSnapshot()[0]).toMatchObject({ running: false, lastStatus: 'timeout' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    expect(launchOffTickJob('slow', async () => undefined, { deadlineMs: 5 }).offTick).toMatchObject({ run: 2, lastStatus: 'timeout' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('reports degraded history and logs failures', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    launchOffTickJob('bad', async () => { throw new Error('broken'); }, { deadlineMs: 10, log });
    await vi.advanceTimersByTimeAsync(0);
    expect(launchOffTickJob('bad', async () => undefined, { deadlineMs: 10 }).offTick).toMatchObject({ lastStatus: 'degraded', lastError: 'broken' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('degraded'));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cascades parent and shutdown abort, bounding shutdown for uncooperative work', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const signals: AbortSignal[] = [];
    const run = (s: AbortSignal): Promise<void> => { signals.push(s); return new Promise(() => undefined); };
    launchOffTickJob('parent', run, { deadlineMs: 100, parentSignal: parent.signal });
    launchOffTickJob('shutdown', run, { deadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    expect(signals[0]?.aborted).toBe(true);
    const cancelled = cancelOffTickJobs(2);
    expect(signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    await cancelled;
  });

  it('logs skipped work without letting logger failures prevent settlement', async () => {
    vi.useFakeTimers();
    const log = vi.fn(() => { throw new Error('logger failed'); });
    launchOffTickJob('skip', async () => skipTickPhase('nothing to do'), { deadlineMs: 10, log });
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
    expect(offTickJobsSnapshot()[0]).toMatchObject({ running: false, lastStatus: 'skipped' });
  });

  it('detaches budget, progress marker and ledger ownership, ignoring off-tick outcomes', async () => {
    vi.useFakeTimers();
    beginTickPhases({ budgetMs: 0 });
    const phase = runTickPhase('background', async () => { expect(tickPhasesSnapshot()).toEqual([]); return 42; }, { detached: true, deadlineMs: 10 });
    await expect(phase).resolves.toMatchObject({ status: 'ok', value: 42 });
    expect(endTickPhases()).toEqual([]);
    expect(deriveTickOutcome({ phases: [{ name: 'heal', status: 'off-tick', durationMs: 0, offTick: { state: 'running', run: 1, since: new Date().toISOString(), lastStatus: 'timeout' } }] })).toBe('ok');
    expect(offTickJobsSnapshot()).toEqual([]);
    await cancelOffTickJobs();
  });

  it('round-trips off-tick state, dropping malformed metadata and bounding strings', () => {
    const row = { name: 'heal', status: 'off-tick' as const, durationMs: 0, offTick: { state: 'started' as const, run: 1, since: new Date().toISOString(), lastStatus: 'degraded' as const, lastError: 'x'.repeat(400) } };
    saveDaemonState({ ...freshDaemonState(), lastTickPhases: [row, { ...row, offTick: { ...row.offTick, run: -1 } }] });
    const phases = loadDaemonState().lastTickPhases;
    expect(phases?.[0]).toEqual({ ...row, offTick: { ...row.offTick, lastError: 'x'.repeat(300) } });
    expect(phases?.[1]?.offTick).toBeUndefined();
  });
});
