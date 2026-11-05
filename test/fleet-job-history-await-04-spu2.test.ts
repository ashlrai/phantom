import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetJobHistoryBatch } from '../src/cli/fleet-job-history-batch.js';
import { awaitJobHistory, type AwaitEnv } from '../src/core/fleet/job-history-await.js';
import type { JobHistoryBatchResult } from '../src/core/fleet/job-history-batch.js';

const OID = 'f'.repeat(40);

const snapshot = (ids: string[], observed: string[]): JobHistoryBatchResult => ({
  resolvedRef: OID, scanBound: 1000, scanned: 3, scanMayBeTruncated: false, limit: 20,
  jobs: ids.map(jobId => ({
    jobId, matchesTruncated: false,
    commits: observed.includes(jobId)
      ? [{ sha: OID, date: '2026-11-04T00:00:00Z', pr: 1, paths: [`p/${jobId}.ts`] }]
      : [],
    paths: observed.includes(jobId) ? [`p/${jobId}.ts`] : [],
  })),
});

interface FakeClock {
  env: AwaitEnv;
  advance: (ms: number) => Promise<void>;
  timers: Array<{ at: number; fn: () => void }>;
}

/** Manual monotonic clock + timer queue; advance() fires due timers then flushes microtasks. */
function fakeClock(read: AwaitEnv['read']): FakeClock {
  let t = 0;
  const timers: FakeClock['timers'] = [];
  const env: AwaitEnv = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: handle => { const i = timers.indexOf(handle as never); if (i >= 0) timers.splice(i, 1); },
    read,
  };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    env, timers,
    advance: async (ms: number) => {
      t += ms;
      timers.sort((a, b) => a.at - b.at);
      while (timers.length && timers[0]!.at <= t) timers.shift()!.fn();
      await flush(); await flush(); await flush();
    },
  };
}

it('observes ids appearing across successive snapshots with no overlap or leftover timers', async () => {
  const ids = ['RQ-AWA-1', 'RQ-AWA-2'];
  const reads: number[] = [];
  let inFlight = false;
  const read = vi.fn(async () => {
    expect(inFlight).toBe(false);
    inFlight = true;
    reads.push(1);
    await Promise.resolve();
    inFlight = false;
    return snapshot(ids, reads.length >= 2 ? ids : ['RQ-AWA-1']);
  });
  const clock = fakeClock(read);
  const pending = awaitJobHistory(ids, 20, 5_000, 250, clock.env);
  await clock.advance(0); // first observation settles, interval timer is queued
  expect(read).toHaveBeenCalledTimes(1);
  await clock.advance(250); // second observation finds both ids
  const result = await pending;
  expect(result).toMatchObject({
    outcome: 'observed', observations: 2, observedIds: ids, pendingIds: [],
  });
  expect(result.snapshot!.jobs.every(job => job.commits.length === 1)).toBe(true);
  expect(clock.timers).toHaveLength(0);
});

it('deadline keeps partial evidence: observed ids reported, missing id stays pending', async () => {
  const ids = ['RQ-AWA-1', 'RQ-AWA-2'];
  const read = vi.fn(async () => snapshot(ids, ['RQ-AWA-1']));
  const clock = fakeClock(read);
  const pending = awaitJobHistory(ids, 20, 1_000, 250, clock.env);
  for (const step of [0, 250, 250, 250, 250]) await clock.advance(step);
  const result = await pending;
  expect(result.outcome).toBe('deadline');
  expect(result.observations).toBe(4); // t=0, 250, 500, 750 — nothing scheduled past the deadline
  expect(result.observedIds).toEqual(['RQ-AWA-1']);
  expect(result.pendingIds).toEqual(['RQ-AWA-2']);
  expect(result.elapsedMs).toBe(1_000);
  expect(clock.timers).toHaveLength(0);
});

it('--await-ms 0 performs exactly one full observation', async () => {
  const read = vi.fn(async () => snapshot(['RQ-AWA-1'], ['RQ-AWA-1']));
  const clock = fakeClock(read);
  const result = await awaitJobHistory(['RQ-AWA-1'], 20, 0, 250, clock.env);
  expect(read).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ outcome: 'observed', observations: 1, elapsedMs: 0 });
});

it('a stalled reader returns at the wall deadline instead of hanging', async () => {
  const read = vi.fn(() => new Promise<JobHistoryBatchResult>(() => {}));
  const clock = fakeClock(read);
  const pending = awaitJobHistory(['RQ-AWA-1'], 20, 500, 250, clock.env);
  await clock.advance(500);
  const result = await pending;
  expect(read).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    outcome: 'deadline', observations: 1, pendingIds: ['RQ-AWA-1'], snapshot: null, elapsedMs: 500,
  });
  expect(clock.timers).toHaveLength(0);
});

it('a late reader rejection after the deadline is swallowed safely', async () => {
  let reject: (err: Error) => void = () => {};
  const read = vi.fn(() => new Promise<JobHistoryBatchResult>((_, r) => { reject = r; }));
  const clock = fakeClock(read);
  const pending = awaitJobHistory(['RQ-AWA-1'], 20, 500, 250, clock.env);
  await clock.advance(500);
  const result = await pending;
  expect(result.outcome).toBe('deadline');
  reject(new Error('late failure'));
  await clock.advance(0); // must not throw or flip the outcome
  expect(result.snapshot).toBeNull();
});

it('a reader error before the deadline propagates, never success or empty evidence', async () => {
  const read = vi.fn(async () => { throw new Error('git exploded'); });
  const clock = fakeClock(read);
  await expect(awaitJobHistory(['RQ-AWA-1'], 20, 5_000, 250, clock.env)).rejects.toThrow('git exploded');
  expect(clock.timers).toHaveLength(0);
});

it('invalid await flags fail before any git call', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const args of [
      ['RQ-AWA-1', '--interval-ms', '500'],       // interval without await
      ['RQ-AWA-1', '--await-ms', '60001'],        // above bound
      ['RQ-AWA-1', '--await-ms', 'x'],            // not an integer
      ['RQ-AWA-1', '--await-ms', '1000', '--interval-ms', '100'], // below bound
      ['RQ-AWA-1', '--await-ms', '1000', '--interval-ms', '10001'],
    ]) expect(await cmdFleetJobHistoryBatch(args)).toBe(2);
  } finally { error.mockRestore(); }
});

it('runs the real command end-to-end in a temporary git repo, no fetch and no mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-history-await-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'landed.txt'), 'a');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-AWA-1): landed job (#21)');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const oid = git('rev-parse', 'HEAD').trim();
    process.chdir(dir);
    // Already-landed id is observed on the first observation.
    expect(await cmdFleetJobHistoryBatch(['RQ-AWA-1', '--await-ms', '30000', '--json'])).toBe(0);
    const observed = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(observed).toMatchObject({ outcome: 'observed', observedIds: ['RQ-AWA-1'], pendingIds: [] });
    expect(observed.snapshot.resolvedRef).toBe(oid);
    expect(observed.snapshot.scanBound).toBe(1000);
    // Missing id with zero budget: one observation, then deadline — pending, never failed.
    expect(await cmdFleetJobHistoryBatch(['RQ-AWA-9', '--await-ms', '0', '--json'])).toBe(3);
    const deadline = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(deadline).toMatchObject({ outcome: 'deadline', pendingIds: ['RQ-AWA-9'], observations: 1 });
    expect(deadline.snapshot.jobs[0].commits).toEqual([]);
    // No network fetch happened and the worktree gained no state.
    expect(existsSync(join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    // One-shot default path is unchanged.
    expect(await cmdFleetJobHistoryBatch(['RQ-AWA-1', '--json'])).toBe(0);
    const oneShot = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(oneShot.outcome).toBeUndefined();
    expect(oneShot.resolvedRef).toBe(oid);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
