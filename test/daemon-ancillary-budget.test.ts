import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

const mocks = vi.hoisted(() => ({ replay: vi.fn(), outcomes: vi.fn(), learning: vi.fn(), credit: vi.fn(), regression: vi.fn() }));
vi.mock('../src/core/daemon/activation-permit.js', () => ({ consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'test-authorized' }), isDaemonActivationCapability: () => true }));
vi.mock('../src/core/fleet/self-heal.js', () => ({ runSelfHealCycle: async () => ({ checked: 0, checkedRepos: [], broken: [], healItems: [] }), queueSelfHealItem: () => true, pruneQueuedSelfHealItems: () => ({ scanned: 0, removed: 0, failed: false }) }));
vi.mock('../src/core/fleet/counterfactual.js', () => ({ runCounterfactualReplay: mocks.replay }));
vi.mock('../src/core/fleet/outcome-watcher.js', () => ({ scanRealWorldOutcomes: mocks.outcomes }));
vi.mock('../src/core/fleet/self-improve.js', () => ({ sweepRejectionLearning: mocks.learning }));
vi.mock('../src/core/fleet/post-merge-credit.js', () => ({ sweepPostMergeCreditReleases: mocks.credit }));
vi.mock('../src/core/fleet/regression-sentinel.js', () => ({ detectRegression: mocks.regression, bisectAndRevert: vi.fn() }));
vi.mock('../src/core/learn/reflect.js', () => ({ runReflectionCycle: async () => undefined }));
vi.mock('../src/core/portfolio/backlog.js', () => ({ buildBacklog: async () => ({ generatedAt: new Date().toISOString(), repos: [], items: [] }) }));
vi.mock('../src/core/fleet/automerge-pass.js', () => ({ runAutoMergePass: async () => ({ merged: 0 }) }));

import { tick } from '../src/core/daemon/loop.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import { ANCILLARY_OBSERVATION_BUDGET_MS, type AncillaryBudgetOptions } from '../src/core/fleet/ancillary-budget.js';
import { cancelOffTickJobs, resetOffTickJobsForTests } from '../src/core/daemon/off-tick-jobs.js';
import { loadDaemonState } from '../src/core/daemon/state.js';
import { ownsOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';

let fx: H1Fixture;
beforeEach(() => {
  vi.clearAllMocks();
  fx = makeFixture(); fx.makeRepo().enroll();
  mocks.credit.mockReturnValue({ scanned: 0, released: 0 });
  mocks.regression.mockImplementation(async (_cfg, _repo, opts) => {
    expect(ownsOutwardMutationFence(opts.authority)).toBe(true);
    return { regressed: false };
  });
  mocks.learning.mockReturnValue({ scanned: 0, written: 0, skipped: 0, sourceComplete: true });
});
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); await cancelOffTickJobs(1000); resetOffTickJobsForTests(); fx.cleanup();
});

it('records shared-budget skips and still runs credit release and regression with authority', async () => {
  let clock = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  mocks.replay.mockImplementation(async (_cfg, controls: AncillaryBudgetOptions) => {
    expect(controls.signal).toBeInstanceOf(AbortSignal);
    clock += ANCILLARY_OBSERVATION_BUDGET_MS;
    vi.setSystemTime(clock);
  });
  const cfg = makeCfg({ foundry: { counterfactual: true, outcomeWatcher: true, selfImprove: true, regressionSentinel: true } as AshlrConfig['foundry'] });
  await tick(cfg, { offTickMaintenance: true });
  expect(mocks.replay).toHaveBeenCalledTimes(1);
  expect(mocks.outcomes).not.toHaveBeenCalled(); expect(mocks.learning).not.toHaveBeenCalled();
  expect(mocks.credit).toHaveBeenCalledTimes(1); expect(mocks.regression).toHaveBeenCalledTimes(1);
  const authority = mocks.regression.mock.calls[0]![2].authority;
  expect(authority).toBeDefined();
  expect(ownsOutwardMutationFence(authority)).toBe(false);
  expect(readAudit(200).filter(row => row.action === 'daemon:ancillary-skip').reverse().map(row => row.summary)).toEqual([
    'counterfactual-replay skipped: ancillary-budget', 'outcome-watcher skipped: ancillary-budget', 'rejection-learning skipped: ancillary-budget',
  ]);
  expect(loadDaemonState().counterfactualReplayPending).toBe(true);
  expect(loadDaemonState().ticks).toHaveLength(1);
  mocks.replay.mockResolvedValue(undefined);
  vi.setSystemTime(clock + 1000);
  await tick(cfg, { offTickMaintenance: true });
  expect(mocks.replay).toHaveBeenCalledTimes(2);
  expect(mocks.outcomes).toHaveBeenCalledTimes(1); expect(mocks.learning).toHaveBeenCalledTimes(1);
  expect(loadDaemonState().counterfactualReplayPending).toBe(false);
});
