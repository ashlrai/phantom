import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AshlrConfig, DaemonTick } from '../src/core/types.js';
import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';

const mocks = vi.hoisted(() => ({ heal: vi.fn(), ancillary: vi.fn(), reflection: vi.fn(), backlog: vi.fn(), dispatch: vi.fn(), merge: vi.fn(), bridge: vi.fn() }));
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) =>
    Array.isArray(args[1]) && args[1].some(arg => /[/\\]ready-bridge-child\.[jt]s$/.test(arg))
      ? mocks.bridge() : actual.spawn(...args) };
});
vi.mock('../src/core/daemon/activation-permit.js', () => ({ consumeDaemonActivationPermit: () => ({ authorized: true, required: false, reason: 'test-authorized' }), isDaemonActivationCapability: () => true }));
vi.mock('../src/core/fleet/self-heal.js', () => ({ runSelfHealCycle: mocks.heal, runSelfHealCycleForRepos: mocks.heal, queueSelfHealItem: () => true, pruneQueuedSelfHealItems: () => ({ scanned: 0, removed: 0, failed: false }) }));
vi.mock('../src/core/fleet/counterfactual.js', () => ({ runCounterfactualReplay: mocks.ancillary }));
vi.mock('../src/core/fleet/self-improve.js', () => ({ sweepRejectionLearning: () => ({ scanned: 0, written: 0, skipped: 0, sourceComplete: true }) }));
vi.mock('../src/core/learn/reflect.js', () => ({ runReflectionCycle: mocks.reflection }));
vi.mock('../src/core/portfolio/backlog.js', () => ({ buildBacklog: mocks.backlog }));
vi.mock('../src/core/swarm/runner.js', () => ({ runSwarm: mocks.dispatch }));
vi.mock('../src/core/fleet/automerge-pass.js', () => ({ runAutoMergePass: mocks.merge }));
import { tick } from '../src/core/daemon/loop.js';
import { loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { cancelOffTickJobs, offTickJobsSnapshot, resetOffTickJobsForTests } from '../src/core/daemon/off-tick-jobs.js';
import { tickPhasesSnapshot } from '../src/core/daemon/tick-phases.js';

let fx: H1Fixture;
let initialRepo: string;
let release: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  fx = makeFixture();
  const repo = fx.makeRepo();
  repo.enroll();
  initialRepo = repo.dir;
  let serial = 0;
  mocks.backlog.mockImplementation(async () => ({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [{ id: `offload-${++serial}`, repo: repo.dir, source: 'todo', title: 'test task', detail: 'test task detail', value: 3, effort: 1, score: 3, tags: [], ts: new Date().toISOString() }] }));
  mocks.dispatch.mockResolvedValue({ id: 'offload-run', status: 'done', usage: { totalTokens: 0, estCostUsd: 0, steps: 1 } });
  mocks.merge.mockResolvedValue({ merged: 0 });
  mocks.heal.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mocks.ancillary.mockResolvedValue(undefined);
  mocks.reflection.mockResolvedValue(undefined);
  release = () => undefined;
});
afterEach(async () => {
  release();
  await cancelOffTickJobs(1000);
  resetOffTickJobsForTests();
  fx.cleanup();
});

const cfg = (selfImprove = false) => makeCfg({ foundry: { counterfactual: false, outcomeWatcher: false, selfImprove } as AshlrConfig['foundry'] });
async function tickWithLedger(offTickMaintenance?: boolean, dryRun = false, selfImprove = false): Promise<DaemonTick> {
  const result = await tick(cfg(selfImprove), { dryRun, offTickMaintenance });
  return { ...result, phases: tickPhasesSnapshot() };
}
const phase = (result: DaemonTick, name: string) => result.phases?.find((row) => row.name === name);
function clearCadence(): void {
  const state = loadDaemonState();
  state.ticks = [];
  saveDaemonState(state);
}

it('keeps fence-bound maintenance on-tick while the second tick runs beside off-tick reflection', async () => {
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  mocks.reflection.mockImplementation(() => blocked);
  clearCadence();
  const first = await tickWithLedger(true, false, true);
  expect(first.reason).toBe('ok');
  expect(phase(first, 'self-heal')?.status).toBe('ok');
  expect(phase(first, 'ancillary')?.status).toBe('ok');
  expect(phase(first, 'reflection')?.offTick).toMatchObject({ state: 'started', run: 1 });
  const names = first.phases?.map((row) => row.name) ?? [];
  expect(names.indexOf('auto-merge')).toBeLessThan(names.indexOf('backlog-refresh'));
  await vi.waitFor(() => expect(mocks.reflection).toHaveBeenCalledTimes(1));
  clearCadence();
  const second = await tickWithLedger(true, false, true);
  expect(second.reason).toBe('ok');
  expect(phase(second, 'self-heal')?.status).toBe('ok');
  expect(phase(second, 'ancillary')?.status).toBe('ok');
  expect(phase(second, 'reflection')?.offTick).toMatchObject({ state: 'running', run: 1 });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  expect(mocks.reflection).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(offTickJobsSnapshot().every((job) => !job.running)).toBe(true));
});

it('keeps maintenance in-tick and auto-merge after dispatch without the flag', async () => {
  const result = await tickWithLedger();
  expect(result.reason).toBe('ok');
  for (const name of ['self-heal', 'ancillary']) expect(result.phases).toContainEqual(expect.objectContaining({ name, status: 'ok' }));
  const names = result.phases?.map((row) => row.name) ?? [];
  expect(names.indexOf('auto-merge')).toBeGreaterThan(names.indexOf('dispatch'));
  expect(offTickJobsSnapshot()).toEqual([]);
});

it('does not wait for or overlap a configured resident node bridge', async () => {
  writeFileSync(join(process.env.ASHLR_HOME!, 'node-bridge.json'), JSON.stringify({ enabled: true, owner: 'test' }));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
  let closed = false;
  release = () => {
    if (closed) return;
    closed = true;
    child.stdout.end('{"claimed":[]}');
    child.emit('close', 0);
  };
  mocks.bridge.mockReturnValue(child);

  expect(phase(await tickWithLedger(true), 'node-bridge')).toMatchObject({
    status: 'off-tick', durationMs: 0, offTick: { state: 'started', run: 1 },
  });
  expect(phase(await tickWithLedger(true), 'node-bridge')?.offTick).toMatchObject({ state: 'running', run: 1 });
  expect(mocks.bridge).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(offTickJobsSnapshot().find(job => job.name === 'node-bridge'))
    .toMatchObject({ running: false, lastStatus: 'ok' }));
});

it('refreshes an empty backlog after the in-tick self-heal without repeating auto-merge', async () => {
  mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [], items: [] });
  const result = await tickWithLedger(true);
  expect(result.reason).toBe('no-backlog');
  expect(mocks.backlog).toHaveBeenCalledTimes(2);
  expect(mocks.merge).toHaveBeenCalledTimes(1);
  expect(phase(result, 'self-heal')?.status).toBe('ok');
});

it('refreshes a green self-heal before dispatching its stale backlog item', async () => {
  const repo = fx.makeRepo();
  repo.enroll();
  const staleHealItem = {
    id: 'stale-heal',
    repo: repo.dir,
    source: 'self',
    title: 'Rebuild the project',
    detail: 'Verify the build after a failure',
    value: 3,
    effort: 1,
    score: 3,
    tags: ['self-heal'],
    ts: new Date().toISOString(),
  };
  const events: string[] = [];
  let refresh = 0;
  mocks.backlog.mockImplementation(async () => {
    events.push('backlog');
    refresh++;
    return {
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: refresh === 1 ? [staleHealItem] : [],
    };
  });
  mocks.heal.mockImplementation(async () => {
    events.push('self-heal');
    return { checked: 1, broken: [], healItems: [] };
  });

  const result = await tickWithLedger(true);

  expect(events).toEqual(['backlog', 'self-heal', 'backlog']);
  expect(mocks.backlog).toHaveBeenCalledTimes(2);
  expect(phase(result, 'self-heal')?.status).toBe('ok');
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('ignores offloading for dry runs', async () => {
  writeFileSync(join(process.env.ASHLR_HOME!, 'node-bridge.json'), JSON.stringify({ enabled: true, owner: 'test' }));
  const result = await tickWithLedger(true, true);
  expect(result.phases?.some((row) => row.status === 'off-tick')).toBe(false);
  expect(mocks.heal).not.toHaveBeenCalled();
  expect(mocks.bridge).not.toHaveBeenCalled();
  expect(offTickJobsSnapshot()).toEqual([]);
});

it.each([false, true])('invalidates only checked repos after self-heal (stale backlog: %s)', async (staleBacklog) => {
  const repoA = fx.makeRepo(); repoA.enroll();
  const repoB = { dir: initialRepo };
  const stale = { id: 'incremental-heal', repo: repoA.dir, source: 'self', title: 'Repair build failure', detail: 'Fix the failing build', value: 3, effort: 1, score: 3, tags: ['self-heal'], ts: new Date().toISOString() };
  let refresh = 0;
  mocks.backlog.mockImplementation(async () => ({ generatedAt: new Date().toISOString(), repos: [repoA.dir, repoB.dir], items: ++refresh === 1 && staleBacklog ? [stale] : [] }));
  mocks.heal.mockResolvedValue({ checked: 1, checkedRepos: [repoA.dir], broken: [], healItems: [] });

  await tickWithLedger(true);

  expect(mocks.heal).toHaveBeenCalledTimes(1);
  expect(mocks.backlog).toHaveBeenCalledTimes(2);
  const [initial] = mocks.backlog.mock.calls[0]!;
  const [afterHeal] = mocks.backlog.mock.calls[1]!;
  expect(initial.repos).toContain(repoB.dir);
  expect(afterHeal.invalidate).toEqual({ repos: [repoA.dir], scanners: ['queued-autonomy'] });
  expect(afterHeal.snapshot).toBe(initial.snapshot);
  expect(afterHeal.signal).toBeInstanceOf(AbortSignal);
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it.each(['empty', 'missing', 'throws'])('handles %s self-heal results conservatively', async (kind) => {
  mocks.backlog.mockResolvedValue({ generatedAt: new Date().toISOString(), repos: [], items: [] });
  if (kind === 'throws') mocks.heal.mockRejectedValueOnce(new Error('self-heal failed'));
  else mocks.heal.mockResolvedValueOnce(kind === 'empty' ? { checked: 0, checkedRepos: [], broken: [], healItems: [] } : undefined);
  await tickWithLedger(true);
  const [initial] = mocks.backlog.mock.calls[0]!;
  const [afterHeal] = mocks.backlog.mock.calls[1]!;
  expect(afterHeal.invalidate).toEqual({ repos: kind === 'empty' ? [] : initial.repos, scanners: ['queued-autonomy'] });
});
