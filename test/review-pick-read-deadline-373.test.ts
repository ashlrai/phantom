import { afterEach, describe, expect, it, vi } from 'vitest';
import { readReviewPick, type ReviewPickReadOptions } from '../src/core/fleet/review-pick.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { BusWorkClaimView, BusWorkClaimsInspection } from '../src/core/fleet/bus-work-claims.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-14T16:00:00Z');
const REPO = 'ashlrai/phantom';
const TIMEOUT = 1_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ghRow = (number: number, headSha: string, rq: string) => ({
  number, title: `bridge: ${rq}`, headRefName: `codex-bridge/${rq}`,
  headRefOid: headSha, isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-14T10:00:00Z',
});

const emptyBoard = (): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
});
const emptyWorkers = (): LiveWorkersSnapshot => ({
  v: 1, generatedAt: '2026-11-14T16:00:00.000Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0,
});
const busClaim = (id: string, over: Partial<BusWorkClaimView> = {}): BusWorkClaimView => ({
  id, cursor: 1, receivedAt: NOW - 60_000, owner: 'devin', leaseUntil: NOW + 60_000, completedAt: null, ...over,
});
const boardClaim = (task: string, over: Partial<FleetClaim> = {}): FleetClaim => ({
  id: 'claim-fake-1', repo: REPO, task, agent: 'claude', claimedAt: NOW - 60_000, expiresAt: NOW + 60_000, ...over,
});

const healthyGh = (rows: unknown[]) => async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' });

function deps(over: Partial<ReviewPickReadOptions> = {}): ReviewPickReadOptions {
  return {
    repo: REPO,
    readTimeoutMs: TIMEOUT,
    gh: healthyGh([ghRow(920001, 'a'.repeat(40), 'RQ-DEADLINE-1')]),
    readClaimedTsv: async () => ({ state: 'healthy' as const, text: '' }),
    inspectBusWork: (): BusWorkClaimsInspection => ({ source: 'available', claims: [] }),
    readBoard: () => emptyBoard(),
    listWorkers: async () => emptyWorkers(),
    now: () => NOW,
    ...over,
  };
}

async function settle(ms = TIMEOUT) {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readReviewPick read deadline', () => {
  it('times out a pending claimed.tsv read, names it unavailable and keeps peer evidence', async () => {
    vi.useFakeTimers();
    const claimed = deferred<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>();
    const busWork: BusWorkClaimsInspection = { source: 'available', claims: [busClaim('RQ-DEADLINE-OTHER')] };
    const reportPromise = readReviewPick(deps({
      readClaimedTsv: () => claimed.promise,
      inspectBusWork: () => busWork,
      readBoard: () => ({ ...emptyBoard(), claims: [boardClaim('RQ-DEADLINE-BOARD')] }),
    }));
    await settle();
    const report = await reportPromise;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    expect(report.source.claims['claimed-tsv']).toBe('unavailable');
    expect(report.source.unavailable).toEqual(['claimed-tsv']);
    expect(report.source.claims['bus-work-claims']).toBe('read');
    expect(report.source.claims.coordination).toBe('read');
    expect(report.source.claims['live-workers']).toBe('read');
    expect(report.source.prs).toBe('read');
    expect(report.skipped).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    claimed.resolve({ state: 'healthy', text: '' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('still reports healthy-peer ownership in skipped while another source timed out', async () => {
    vi.useFakeTimers();
    const claimed = deferred<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>();
    const reportPromise = readReviewPick(deps({
      readClaimedTsv: () => claimed.promise,
      inspectBusWork: () => ({ source: 'available', claims: [busClaim('RQ-DEADLINE-1')] }),
    }));
    await settle();
    const report = await reportPromise;
    expect(report.picked).toBeNull();
    expect(report.source.unavailable).toEqual(['claimed-tsv']);
    expect(report.skipped).toEqual([
      { pr: 920001, owner: 'devin', why: "live claim 'RQ-DEADLINE-1' via bus-work-claims" },
    ]);
    expect(JSON.stringify(report)).not.toContain('"none"');
    claimed.resolve({ state: 'healthy', text: '' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('times out a pending live-workers read and names it unavailable', async () => {
    vi.useFakeTimers();
    const workers = deferred<LiveWorkersSnapshot>();
    const reportPromise = readReviewPick(deps({ listWorkers: () => workers.promise }));
    await settle();
    const report = await reportPromise;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    expect(report.source.claims['live-workers']).toBe('unavailable');
    expect(report.source.unavailable).toEqual(['live-workers']);
    expect(report.source.claims['claimed-tsv']).toBe('read');
    expect(vi.getTimerCount()).toBe(0);
    workers.resolve(emptyWorkers());
    await vi.advanceTimersByTimeAsync(0);
  });

  it('times out a pending gh read and reports the pr source unavailable', async () => {
    vi.useFakeTimers();
    const gh = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const reportPromise = readReviewPick(deps({ gh: () => gh.promise }));
    await settle();
    const report = await reportPromise;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('pr source unavailable');
    expect(report.source.prs).toBe('unavailable');
    expect(report.source.unavailable).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    gh.resolve({ ok: true, stdout: '[]', stderr: '' });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('clears its timer on a healthy read', async () => {
    vi.useFakeTimers();
    const report = await readReviewPick(deps());
    expect(report.picked).toMatchObject({ pr: 920001, owner: 'none' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TIMEOUT * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a retry after a timeout reads the current head, and a late old result cannot stale it', async () => {
    vi.useFakeTimers();
    const staleClaimed = deferred<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>();
    const first = readReviewPick(deps({ readClaimedTsv: () => staleClaimed.promise }));
    await settle();
    const report1 = await first;
    expect(report1.picked).toBeNull();
    expect(report1.source.unavailable).toEqual(['claimed-tsv']);

    let ghCalls = 0;
    const second = readReviewPick(deps({
      gh: async () => {
        ghCalls += 1;
        return { ok: true, stdout: JSON.stringify([ghRow(920002, 'b'.repeat(40), 'RQ-DEADLINE-2')]), stderr: '' };
      },
      readClaimedTsv: async () => ({ state: 'healthy' as const, text: 'RQ-DEADLINE-2\tcodex-local\twork\t15:00\t1\n' }),
    }));
    await settle();
    const report2 = await second;
    expect(ghCalls).toBe(1);
    expect(report2.picked).toBeNull();
    expect(report2.skipped).toEqual([
      { pr: 920002, owner: 'codex-local', why: "live claim 'RQ-DEADLINE-2' via claimed-tsv" },
    ]);

    // Resolve the first call's stalled reader with data that would have owned
    // a different PR; the returned reports must not move.
    const before1 = JSON.stringify(report1);
    const before2 = JSON.stringify(report2);
    staleClaimed.resolve({ state: 'healthy', text: 'RQ-DEADLINE-1\tgemini\twork\t15:00\t1\n' });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(report1)).toBe(before1);
    expect(JSON.stringify(report2)).toBe(before2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a retry picks the new unowned head after the stalled read recovered', async () => {
    vi.useFakeTimers();
    const staleClaimed = deferred<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>();
    const first = readReviewPick(deps({ readClaimedTsv: () => staleClaimed.promise }));
    await settle();
    await first;

    const second = readReviewPick(deps({
      gh: healthyGh([ghRow(920003, 'c'.repeat(40), 'RQ-DEADLINE-3')]),
      readClaimedTsv: async () => ({ state: 'healthy' as const, text: '' }),
    }));
    await settle();
    const report2 = await second;
    expect(report2.picked).toMatchObject({ pr: 920003, head_sha: 'c'.repeat(40), owner: 'none' });
    expect(report2.source.unavailable).toEqual([]);

    staleClaimed.resolve({ state: 'healthy', text: 'RQ-DEADLINE-3\tgemini\twork\t15:00\t1\n' });
    await vi.advanceTimersByTimeAsync(0);
    expect(report2.picked).toMatchObject({ pr: 920003, owner: 'none' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late rejection from a timed-out read is handled, not unhandled', async () => {
    vi.useFakeTimers();
    const workers = deferred<LiveWorkersSnapshot>();
    const reportPromise = readReviewPick(deps({ listWorkers: () => workers.promise }));
    await settle();
    const report = await reportPromise;
    expect(report.source.unavailable).toEqual(['live-workers']);
    workers.reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
