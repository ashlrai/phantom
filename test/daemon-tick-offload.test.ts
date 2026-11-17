import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AshlrConfig, DaemonTick } from '../src/core/types.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

const mocks = vi.hoisted(() => ({ heal: vi.fn(), ancillary: vi.fn(), backlog: vi.fn(), dispatch: vi.fn(), merge: vi.fn() }));
vi.mock('../src/core/daemon/activation-permit.js', () => ({ consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'test-authorized' }), isDaemonActivationCapability: () => true }));
vi.mock('../src/core/fleet/self-heal.js', () => ({ runSelfHealCycle: mocks.heal, runSelfHealCycleForRepos: mocks.heal, queueSelfHealItem: () => true, pruneQueuedSelfHealItems: () => ({ scanned: 0, removed: 0, failed: false }) }));
vi.mock('../src/core/fleet/counterfactual.js', () => ({ runCounterfactualReplay: mocks.ancillary }));
vi.mock('../src/core/portfolio/backlog.js', () => ({ buildBacklog: mocks.backlog }));
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm: mocks.dispatch }));
vi.mock('../src/core/fleet/automerge-pass.js', () => ({ runAutoMergePass: mocks.merge }));
import { tick } from '../src/core/daemon/loop.js';
import { loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { cancelOffTickJobs, offTickJobsSnapshot, resetOffTickJobsForTests } from '../src/core/daemon/off-tick-jobs.js';
import { tickPhasesSnapshot } from '../src/core/daemon/tick-phases.js';

let fx: H1Fixture;
let release: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  fx = makeFixture();
  const repo = fx.makeRepo();
  repo.enroll();
  let serial = 0;
  mocks.backlog.mockImplementation(async () => ({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [{ id: `offload-${++serial}`, repo: repo.dir, source: 'todo', title: 'test task', detail: 'test task detail', value: 3, effort: 1, score: 3, tags: [], ts: new Date().toISOString() }] }));
  mocks.dispatch.mockResolvedValue({ id: 'offload-run', status: 'done', usage: { totalTokens: 0, estCostUsd: 0, steps: 1 } });
  mocks.merge.mockResolvedValue({ merged: 0 });
  mocks.heal.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mocks.ancillary.mockResolvedValue(undefined);
  release = () => undefined;
});
afterEach(async () => {
  release();
  await cancelOffTickJobs(1000);
  resetOffTickJobsForTests();
  fx.cleanup();
});

const cfg = () => makeCfg({ foundry: { counterfactual: true, outcomeWatcher: false } as AshlrConfig['foundry'] });
async function tickWithLedger(offTickMaintenance?: boolean, dryRun = false): Promise<DaemonTick> {
  const result = await tick(cfg(), { dryRun, offTickMaintenance });
  return { ...result, phases: tickPhasesSnapshot() };
}
const phase = (result: DaemonTick, name: string) => result.phases?.find((row) => row.name === name);
function clearCadence(): void {
  const state = loadDaemonState();
  state.ticks = [];
  saveDaemonState(state);
}

it('returns with blocked maintenance, merges first, and reuses running jobs across real ticks', async () => {
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  mocks.heal.mockImplementation(async () => { await blocked; return { checked: 0, broken: [], healItems: [] }; });
  mocks.ancillary.mockImplementation(() => blocked);
  const first = await tickWithLedger(true);
  expect(first.reason).toBe('ok');
  for (const name of ['self-heal', 'ancillary']) expect(first.phases).toContainEqual(expect.objectContaining({ name, status: 'off-tick', durationMs: 0, offTick: expect.objectContaining({ state: 'started' }) }));
  const names = first.phases?.map((row) => row.name) ?? [];
  expect(names.indexOf('auto-merge')).toBeLessThan(names.indexOf('backlog-refresh'));
  expect(names.indexOf('dispatch')).toBeGreaterThan(names.indexOf('auto-merge'));
  clearCadence();
  const second = await tickWithLedger(true);
  for (const name of ['self-heal', 'ancillary']) expect(phase(second, name)?.offTick?.state).toBe('running');
  expect(mocks.heal).toHaveBeenCalledTimes(1);
  expect(mocks.ancillary).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(offTickJobsSnapshot().every((job) => !job.running)).toBe(true));
  clearCadence();
  const third = await tickWithLedger(true);
  for (const name of ['self-heal', 'ancillary']) expect(phase(third, name)?.offTick).toMatchObject({ state: 'started', run: 2, lastStatus: 'ok' });
  expect(mocks.merge).toHaveBeenCalledTimes(3);
});

it('keeps maintenance in-tick and auto-merge after dispatch without the flag', async () => {
  const result = await tickWithLedger();
  expect(result.reason).toBe('ok');
  for (const name of ['self-heal', 'ancillary']) expect(result.phases).toContainEqual(expect.objectContaining({ name, status: 'ok' }));
  const names = result.phases?.map((row) => row.name) ?? [];
  expect(names.indexOf('auto-merge')).toBeGreaterThan(names.indexOf('dispatch'));
  expect(offTickJobsSnapshot()).toEqual([]);
});

it('does not refresh an empty backlog for offloaded heal output or repeat auto-merge', async () => {
  mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [], items: [] });
  const result = await tickWithLedger(true);
  expect(result.reason).toBe('no-backlog');
  expect(mocks.backlog).toHaveBeenCalledTimes(1);
  expect(mocks.merge).toHaveBeenCalledTimes(1);
  expect(phase(result, 'self-heal')?.status).toBe('off-tick');
});

it('ignores offloading for dry runs', async () => {
  const result = await tickWithLedger(true, true);
  expect(result.phases?.some((row) => row.status === 'off-tick')).toBe(false);
  expect(mocks.heal).not.toHaveBeenCalled();
  expect(offTickJobsSnapshot()).toEqual([]);
});
