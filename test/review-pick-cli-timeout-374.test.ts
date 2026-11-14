import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReviewPick, type FleetReviewPickDeps } from '../src/cli/fleet-review-pick.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { ReviewPickReport } from '../src/core/fleet/review-pick.js';
import type { ReviewPickMultiReport } from '../src/core/fleet/review-pick-multi.js';

const NOW = Date.parse('2026-11-14T16:00:00Z');
const ISO = '2026-11-14T16:00:00.000Z';
const REPO = 'ashlrai/phantom';
const TIMEOUT = 500;

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
  v: 1, generatedAt: ISO, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0,
});

type Claimed = { state: 'healthy' | 'missing' | 'degraded'; text: string };

function harness(over: Partial<FleetReviewPickDeps> = {}, ghRows: unknown[] = [ghRow(910001, 'a'.repeat(40), 'RQ-TIMEOUT-1')]) {
  const calls = { gh: 0, readClaimedTsv: 0, inspectBusWork: 0, readBoard: 0, listWorkers: 0 };
  const out: string[] = [];
  const errs: string[] = [];
  const deps: FleetReviewPickDeps = {
    gh: async () => { calls.gh += 1; return { ok: true, stdout: JSON.stringify(ghRows), stderr: '' }; },
    readClaimedTsv: async () => { calls.readClaimedTsv += 1; return { state: 'healthy' as const, text: '' }; },
    inspectBusWork: () => { calls.inspectBusWork += 1; return { source: 'available' as const, claims: [] }; },
    readBoard: () => { calls.readBoard += 1; return emptyBoard(); },
    listWorkers: async () => { calls.listWorkers += 1; return emptyWorkers(); },
    now: () => NOW,
    stdout: t => out.push(t),
    stderr: t => errs.push(t),
    ...over,
  };
  return { deps, calls, out, errs };
}

async function settle(ms = TIMEOUT) {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cmdFleetReviewPick --timeout-ms validation', () => {
  const invalid: [string, string[]][] = [
    ['missing value', ['--timeout-ms']],
    ['repeated flag', ['--timeout-ms', '100', '--timeout-ms', '200']],
    ['fractional', ['--timeout-ms', '1.5']],
    ['non-numeric', ['--timeout-ms', 'abc']],
    ['NaN', ['--timeout-ms', 'NaN']],
    ['Infinity', ['--timeout-ms', 'Infinity']],
    ['zero', ['--timeout-ms', '0']],
    ['negative', ['--timeout-ms', '-250']],
    ['above cap', ['--timeout-ms', '60001']],
    ['exponent form', ['--timeout-ms', '1e3']],
  ];
  for (const [name, argv] of invalid) {
    it(`rejects ${name} with exit 2 before any source read`, async () => {
      const { deps, calls, errs } = harness();
      const code = await cmdFleetReviewPick(argv, deps);
      expect(code).toBe(2);
      expect(calls).toEqual({ gh: 0, readClaimedTsv: 0, inspectBusWork: 0, readBoard: 0, listWorkers: 0 });
      expect(errs.join('')).toContain('error:');
      expect(errs.join('')).toContain('--timeout-ms');
    });
  }

  it('accepts the 1 and 60000 boundaries and still exits 0', async () => {
    for (const ms of ['1', '60000']) {
      const { deps, calls } = harness();
      const code = await cmdFleetReviewPick(['--timeout-ms', ms, '--json'], deps);
      expect(code).toBe(0);
      expect(calls.gh).toBe(1);
    }
  });

  it('prints the flag in --help usage', async () => {
    const { deps, out } = harness();
    expect(await cmdFleetReviewPick(['--help'], deps)).toBe(0);
    expect(out.join('')).toContain('--timeout-ms');
  });
});

describe('cmdFleetReviewPick --timeout-ms bounds live reads', () => {
  it('a hung live-workers read fails unavailable at the bound, exit 1, picked null (JSON)', async () => {
    vi.useFakeTimers();
    const workers = deferred<LiveWorkersSnapshot>();
    const { deps, out } = harness({ listWorkers: () => workers.promise });
    let settled: number | null = null;
    const done = cmdFleetReviewPick(['--timeout-ms', String(TIMEOUT), '--json'], deps)
      .then(code => { settled = code; return code; });

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
    expect(settled).toBeNull();
    await settle(1);
    const code = await done;
    expect(code).toBe(1);
    const report = JSON.parse(out.join('')) as ReviewPickReport;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    expect(report.source.unavailable).toEqual(['live-workers']);
    expect(report.source.claims['live-workers']).toBe('unavailable');
    expect(report.source.prs).toBe('read');
    expect(JSON.stringify(report)).not.toContain('"none"');
    workers.resolve(emptyWorkers());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hung claimed.tsv read fails unavailable at the bound, exit 1 (human output)', async () => {
    vi.useFakeTimers();
    const claimed = deferred<Claimed>();
    const { deps, out } = harness({ readClaimedTsv: () => claimed.promise });
    const done = cmdFleetReviewPick(['--timeout-ms', String(TIMEOUT)], deps);
    await settle();
    const code = await done;
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('picked: none');
    expect(text).toContain('reason: ownership source unavailable');
    expect(text).toContain('source.unavailable: claimed-tsv');
    expect(text).not.toContain('owner: none');
    claimed.resolve({ state: 'healthy', text: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hung gh read reports the pr source unavailable at the bound, exit 1', async () => {
    vi.useFakeTimers();
    const gh = deferred<{ ok: boolean; stdout: string; stderr: string }>();
    const { deps, out } = harness({ gh: () => gh.promise });
    const done = cmdFleetReviewPick(['--timeout-ms', String(TIMEOUT), '--json'], deps);
    await settle();
    const code = await done;
    expect(code).toBe(1);
    const report = JSON.parse(out.join('')) as ReviewPickReport;
    expect(report.picked).toBeNull();
    expect(report.reason).toBe('pr source unavailable');
    expect(report.source.prs).toBe('unavailable');
    gh.resolve({ ok: true, stdout: '[]', stderr: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a later invocation returns the current PR/head once readers recover', async () => {
    vi.useFakeTimers();
    const claimed = deferred<Claimed>();
    const first = harness({ readClaimedTsv: () => claimed.promise });
    const firstDone = cmdFleetReviewPick(['--timeout-ms', String(TIMEOUT), '--json'], first.deps);
    await settle();
    expect(await firstDone).toBe(1);
    const report1 = JSON.parse(first.out.join('')) as ReviewPickReport;
    expect(report1.picked).toBeNull();
    expect(report1.source.unavailable).toEqual(['claimed-tsv']);

    const second = harness({}, [ghRow(910002, 'b'.repeat(40), 'RQ-TIMEOUT-2')]);
    const code2 = await cmdFleetReviewPick(['--timeout-ms', String(TIMEOUT), '--json'], second.deps);
    expect(code2).toBe(0);
    const report2 = JSON.parse(second.out.join('')) as ReviewPickReport;
    expect(report2.picked).toMatchObject({
      repo: REPO, pr: 910002, head: 'codex-bridge/RQ-TIMEOUT-2', head_sha: 'b'.repeat(40), owner: 'none',
    });
    expect(report2.source.unavailable).toEqual([]);

    // A late settlement of the first call's stalled reader cannot move either report.
    claimed.resolve({ state: 'healthy', text: 'RQ-TIMEOUT-2\tgemini\twork\t15:00\t1\n' });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(first.out.join('')).picked).toBeNull();
    expect(JSON.parse(second.out.join('')).picked.pr).toBe(910002);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the bound reaches the multi-repo path: every repo reports the source unavailable', async () => {
    vi.useFakeTimers();
    const workers = deferred<LiveWorkersSnapshot>();
    const { deps, out } = harness({ listWorkers: () => workers.promise });
    const done = cmdFleetReviewPick(
      ['--repo', 'ashlrai/phantom', '--repo', 'ashlrai/gateway', '--timeout-ms', String(TIMEOUT), '--json'], deps);
    // The shared ownership snapshot is read once per repo; repo two's bound
    // starts when repo one's report lands, so the wait is two deadlines deep.
    await settle(TIMEOUT * 2);
    const code = await done;
    expect(code).toBe(1);
    const report = JSON.parse(out.join('')) as ReviewPickMultiReport;
    expect(report.schema).toBe('fleet.review-pick-multi.v1');
    expect(report.first).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    for (const row of report.repos) {
      expect(row.picked).toBeNull();
      expect(row.source.unavailable).toEqual(['live-workers']);
    }
    workers.resolve(emptyWorkers());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
