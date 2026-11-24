import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import { readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const NOW = Date.parse('2026-11-17T14:00:00.000Z');
const DEADLINE = 5;
const PRIVATE = 'synthetic-private-first-read-536s';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(['resolve', 'reject'] as const)('isolates a timed-out read that later %ss during retry', async settlement => {
  const root = mkdtempSync(join(tmpdir(), 'claim-retry-536s-'));
  const first = deferred<LiveWorkersSnapshot>();
  const second = deferred<LiveWorkersSnapshot>();
  const entered = deferred<void>();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const fixtures = ['first', 'second'].map((name, index) => {
      const path = join(root, `${name}.jsonl`);
      const stamp = NOW + index * 1000;
      const job = `RQ-FAKE-${name.toUpperCase()}536S`;
      const repo = `fake-${name}-owner/fake-${name}-repo`;
      const agent = `fake-${name}-agent`;
      const claim = claimFleetWork({ repo, agent, task: `${job} ${PRIVATE}`, ttlMs: 60_000 }, { path, now: NOW - 1000 });
      if (!claim.ok) throw new Error('synthetic fixture claim failed');
      const board = vi.fn((options?: { now?: number }) => readFleetBoard({ ...options, path, reap: false }));
      const snapshot: LiveWorkersSnapshot = {
        v: 1, generatedAt: new Date(stamp).toISOString(), sourceState: 'healthy',
        workers: [{ pid: 101 + index, job, repo, lane: `fake-${name}-lane`, tier: 'work', ageSeconds: 1 }],
        leaders: [], orchestratorAgents: 0,
      };
      return { path, stamp, job, repo, agent, board, snapshot, id: claim.value.claim.id, bytes: readFileSync(path) };
    });
    const [old, current] = fixtures as [typeof fixtures[number], typeof fixtures[number]];
    vi.useFakeTimers();
    const one = readFleetClaimExecution({ now: () => old.stamp, board: old.board, workers: () => first.promise }, DEADLINE);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const unavailable = await one;
    expect(unavailable).toMatchObject({ authority: 'none', asOf: new Date(old.stamp).toISOString(),
      ledger: 'unavailable', processes: 'unavailable', rows: [],
      counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: ['claim execution: read deadline exceeded'] });
    const frozenAnswer = JSON.stringify(unavailable);
    expect(old.board).not.toHaveBeenCalled();
    const two = readFleetClaimExecution({ now: () => current.stamp, board: current.board,
      workers: () => { entered.resolve(); return second.promise; } }, DEADLINE);
    await entered.promise;
    expect(current.board).not.toHaveBeenCalled();
    if (settlement === 'resolve') first.resolve(old.snapshot);
    else first.reject(new Error(PRIVATE));
    await vi.advanceTimersByTimeAsync(0);
    expect(old.board).toHaveBeenCalledOnce();
    expect(current.board).not.toHaveBeenCalled();
    expect(JSON.stringify(unavailable)).toBe(frozenAnswer);
    second.resolve(current.snapshot);
    const recovered = await two;
    expect(recovered).toMatchObject({ authority: 'none', asOf: new Date(current.stamp).toISOString(),
      ledger: 'known', processes: 'healthy', reasons: [], counts: { running: 1, claimedNoWorker: 0, unknown: 0 } });
    expect(recovered.rows).toEqual([{ claimId: current.id, agent: current.agent, repo: current.repo,
      jobId: current.job, state: 'RUNNING', worker: { pid: 102, lane: 'fake-second-lane', tier: 'work', ageSeconds: 1 },
      expiresInSeconds: 58 }]);
    expect(current.board).toHaveBeenCalledOnce();
    for (const marker of [old.id, old.agent, old.repo, old.job, 'fake-first-lane', PRIVATE, new Date(old.stamp).toISOString()]) {
      expect(JSON.stringify(recovered)).not.toContain(marker);
    }
    const third = await readFleetClaimExecution({ now: () => current.stamp, board: current.board,
      workers: async () => current.snapshot }, DEADLINE);
    expect(third).toEqual(recovered);
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).not.toHaveBeenCalled();
    expect(JSON.stringify(await one)).toBe(frozenAnswer);
    expect(vi.getTimerCount()).toBe(0);
    for (const fixture of fixtures) expect(readFileSync(fixture.path)).toEqual(fixture.bytes);
  } finally {
    first.reject(new Error('synthetic cleanup'));
    second.reject(new Error('synthetic cleanup'));
    vi.useRealTimers();
    process.removeListener('unhandledRejection', unhandled);
    rmSync(root, { recursive: true, force: true });
  }
});
