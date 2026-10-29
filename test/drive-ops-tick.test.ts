import { describe, expect, it, vi } from 'vitest';
import {
  OPS_STEPS, P0_PRIORITY, WEEKLY_GROK_PAUSE_PERCENT,
  dashboardRollup, evaluateWeeklyGovernor, governorAllows, isGrokTurnJob,
  reapPlan, restockPlan, runOpsTick, triageFixForward,
  type OpsPorts, type ReapEvidence,
} from '../src/core/drive/ops-tick.js';
import {
  driveTick,
  type DriveBridge, type DriveDependencies, type DriveJob, type DriveSnapshot,
} from '../src/core/drive/supervisor.js';
import type { DriveQueueV1 } from '../src/core/drive/queue-v1.js';

/** Every log line a step may emit: fixed tokens, closed enums, never a value. */
const VALUE_FREE_LINE = /^drive-ops (restock|reap|metrics-export|fixfwd-triage|dashboard-rollup|governor) (ok|skipped|failed|held|open|paused|unknown)$/;

function job(id: string, state: DriveJob['state'] = 'READY', pool = 'grok-build', priority = 0): DriveJob {
  return { id, state, pool, priority, ...(state === 'FINISHED' ? { exitCode: 0 } : {}) };
}

function fixture(jobs: DriveJob[] = [job('next')]) {
  const state: DriveSnapshot = {
    version: 1,
    pools: [{ id: 'grok-build', floor: 0, ceiling: 2 }, { id: 'codex-cmp', floor: 0, ceiling: 2 }],
    maxRunning: 2, paused: false, admission: 'open', jobs,
  };
  const calls: string[] = [];
  const bridge: DriveBridge = {
    snapshot: vi.fn(async () => structuredClone(state)),
    acquire: vi.fn(async () => { calls.push('acquire'); return 'lease'; }),
    reap: vi.fn(async () => { calls.push('reap'); }),
    launch: vi.fn(async (_lease, id) => {
      calls.push(`launch:${id}`);
      state.jobs.find(item => item.id === id)!.state = 'RUNNING';
      return 'launched';
    }),
    reservePublish: vi.fn(async () => false),
    finishPublish: vi.fn(async () => undefined),
    writeStatus: vi.fn(async () => { calls.push('status'); }),
    release: vi.fn(async () => { calls.push('release'); }),
  };
  const logs: string[] = [];
  const deps: DriveDependencies = {
    bridge,
    paused: vi.fn(async () => false),
    publish: vi.fn(async () => undefined),
    now: () => new Date('2026-10-28T12:00:00Z'),
    opsLog: line => logs.push(line),
  };
  return { state, bridge, deps, calls, logs };
}

describe('weekly budget governor', () => {
  it('leaves non-P0 Grok-turn work open at 50 percent', () => {
    const decision = evaluateWeeklyGovernor(50);
    expect(decision).toEqual({ state: 'open', nonP0Paused: false });
    expect(governorAllows(job('g1', 'READY', 'grok-build', 3), decision)).toBe(true);
  });

  it('pauses non-P0 Grok-turn work at 85 percent, the at-or-above watermark', () => {
    const decision = evaluateWeeklyGovernor(85);
    expect(decision).toEqual({ state: 'paused', nonP0Paused: true });
    expect(governorAllows(job('g1', 'READY', 'grok-build', 3), decision)).toBe(false);
    expect(governorAllows(job('g2', 'READY', 'grok-ultra', 8), decision)).toBe(false);
    // P0 work and non-Grok pools are never held by the governor.
    expect(governorAllows(job('p0', 'READY', 'grok-build', P0_PRIORITY), decision)).toBe(true);
    expect(governorAllows(job('c1', 'READY', 'codex-cmp', 0), decision)).toBe(true);
  });

  it('keeps non-P0 Grok-turn work paused at 100 percent while P0 still runs', () => {
    const decision = evaluateWeeklyGovernor(100);
    expect(decision.state).toBe('paused');
    expect(governorAllows(job('g1', 'READY', 'grok-build', 3), decision)).toBe(false);
    expect(governorAllows(job('p0', 'READY', 'grok-ultra', P0_PRIORITY), decision)).toBe(true);
  });

  it('stays open just under the watermark', () => {
    expect(evaluateWeeklyGovernor(84.9).state).toBe('open');
    expect(evaluateWeeklyGovernor(0).state).toBe('open');
  });

  it('fails closed on an unknown reading — unknown usage is not headroom', () => {
    for (const bad of [null, undefined, Number.NaN, -1, 101, Number.POSITIVE_INFINITY]) {
      const decision = evaluateWeeklyGovernor(bad as number | null);
      expect(decision).toEqual({ state: 'unknown', nonP0Paused: true });
      expect(governorAllows(job('g1', 'READY', 'grok-build', 3), decision)).toBe(false);
    }
    expect(WEEKLY_GROK_PAUSE_PERCENT).toBe(85);
  });

  it('honours a custom pause watermark', () => {
    expect(evaluateWeeklyGovernor(60, 50).state).toBe('paused');
    expect(evaluateWeeklyGovernor(60, 70).state).toBe('open');
    expect(evaluateWeeklyGovernor(60, 0).state).toBe('unknown');
  });

  it('recognizes Grok-turn pools', () => {
    expect(isGrokTurnJob(job('a', 'READY', 'grok-build'))).toBe(true);
    expect(isGrokTurnJob(job('b', 'READY', 'grok-ultra'))).toBe(true);
    expect(isGrokTurnJob(job('c', 'READY', 'codex-cmp'))).toBe(false);
    expect(isGrokTurnJob(job('d', 'READY', 'custom', 0), ['custom'])).toBe(true);
  });
});

describe('fixfwd triage', () => {
  const green = (name: string): { name: string; status: string; conclusion: string } =>
    ({ name, status: 'completed', conclusion: 'success' });
  const red = (name: string): { name: string; status: string; conclusion: string } =>
    ({ name, status: 'completed', conclusion: 'failure' });

  it('ignores non-required contexts — SonarCloud, CodeQL and Vercel never force a fix-forward', () => {
    const triage = triageFixForward({
      required: [{ context: 'build' }, { context: 'test' }],
      runs: [green('build'), green('test'), red('SonarCloud'), red('CodeQL'), red('Vercel')],
    });
    expect(triage.verdict).toBe('green');
    expect(triage.failed).toEqual([]);
  });

  it('opens fix-forward only for a red REQUIRED context', () => {
    const triage = triageFixForward({
      required: [{ context: 'build' }, { context: 'test' }],
      runs: [green('build'), red('test'), red('SonarCloud'), red('Vercel')],
    });
    expect(triage.verdict).toBe('fix-forward');
    expect(triage.failed).toEqual(['test']);
  });

  it('waits on missing or in-flight required contexts', () => {
    expect(triageFixForward({ required: [{ context: 'build' }, { context: 'test' }],
      runs: [green('build')] }).verdict).toBe('pending');
    expect(triageFixForward({ required: [{ context: 'build' }],
      runs: [{ name: 'build', status: 'in_progress', conclusion: null }] }).verdict).toBe('pending');
    // A cancelled run is superseded work, not proof either way.
    expect(triageFixForward({ required: [{ context: 'build' }],
      runs: [{ name: 'build', status: 'completed', conclusion: 'cancelled' }] }).verdict).toBe('pending');
  });

  it('reports unknown when required contexts are unreadable and green when none exist', () => {
    expect(triageFixForward({ required: null, runs: [red('CodeQL')] }).verdict).toBe('unknown');
    expect(triageFixForward({ required: [], runs: [red('Vercel')] }).verdict).toBe('green');
  });

  it('counts commit statuses for appId-free requirements and honors appId pinning', () => {
    const triage = triageFixForward({
      required: [{ context: 'verify' }],
      runs: [],
      statuses: [{ context: 'verify', state: 'failure' }, { context: 'SonarCloud', state: 'failure' }],
    });
    expect(triage.verdict).toBe('fix-forward');
    // An appId-pinned requirement ignores statuses and same-named runs from other apps.
    const pinned = triageFixForward({
      required: [{ context: 'verify', appId: 'fleet-app' }],
      runs: [{ name: 'verify', appId: 'other-app', status: 'completed', conclusion: 'success' }],
      statuses: [{ context: 'verify', state: 'failure' }],
    });
    expect(pinned.verdict).toBe('pending');
  });

  it('uses the latest run per context', () => {
    const triage = triageFixForward({
      required: [{ context: 'build' }],
      runs: [
        { id: 1, name: 'build', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'build', status: 'completed', conclusion: 'success' },
      ],
    });
    expect(triage.verdict).toBe('green');
  });
});

describe('ops step helpers', () => {
  it('restockPlan promotes READY rows and holds the rest', () => {
    const row = (id: string, status: DriveQueueV1['jobs'][number]['status'], deps: string[] = []): DriveQueueV1['jobs'][number] =>
      ({ id, status, priority: 'P2', pool: 'grok-build', tier: 'work', repo: 'phantom', deps });
    const plan = restockPlan({ schema: 'queue.v1', jobs: [row('done', 'DONE'), row('go', 'READY', ['done']), row('wait', 'READY', ['missing']), row('hold', 'HOLD')] });
    expect(plan.readyIds).toEqual(['go']);
    expect(plan.heldIds).toEqual(['done', 'wait', 'hold']);
  });

  it('reapPlan reaps only verifiable exits from active jobs', () => {
    const jobs = [job('run', 'RUNNING'), job('start', 'STARTING'), job('done', 'FINISHED'), job('gone', 'RUNNING')];
    const evidence = (id: string): ReapEvidence =>
      ({ run: 'exited-ok', start: 'exited-failed', gone: 'missing' })[id] as ReapEvidence ?? 'running';
    expect(reapPlan(jobs, evidence)).toEqual([
      { id: 'run', to: 'FINISHED' },
      { id: 'start', to: 'FAILED' },
    ]);
  });

  it('dashboardRollup carries counts and closed enums only', () => {
    const rollup = dashboardRollup({
      snapshot: { version: 1, pools: [{ id: 'grok-build', floor: 0, ceiling: 2 }], maxRunning: 2,
        paused: false, admission: 'open',
        jobs: [job('a', 'RUNNING'), job('b', 'READY'), job('c', 'FAILED')] },
      governor: 'paused',
      ops: { restock: 'ok', reap: 'ok' },
      now: () => new Date('2026-10-28T12:00:00Z'),
    });
    expect(rollup).toEqual({
      schema: 'drive-ops-rollup.v1', at: '2026-10-28T12:00:00.000Z',
      admission: 'open', paused: false, governor: 'paused',
      states: { READY: 1, HELD: 0, STARTING: 0, RUNNING: 1, FINISHED: 0, FAILED: 1, PUBLISHING: 0, PUBLISHED: 0, PUBLISH_UNKNOWN: 0 },
      pools: [{ id: 'grok-build', active: 1, ceiling: 2 }],
      ops: { restock: 'ok', reap: 'ok' },
    });
    expect(JSON.stringify(rollup)).not.toMatch(/"jobs"\s*:/);
  });
});

describe('runOpsTick', () => {
  it('runs every provided step once, in order, logging one value-free line each', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const ports: Required<OpsPorts> = Object.fromEntries(
      ['restock', 'reap', 'metricsExport', 'fixfwdTriage', 'dashboardRollup'].map(k => [k, async () => { order.push(k); }]),
    ) as Required<OpsPorts>;
    const results = await runOpsTick(ports, { lease: 'L', log: line => logs.push(line) });
    expect(order).toEqual(['restock', 'reap', 'metricsExport', 'fixfwdTriage', 'dashboardRollup']);
    expect(Object.keys(results)).toEqual([...OPS_STEPS]);
    expect(Object.values(results).every(outcome => outcome === 'ok')).toBe(true);
    expect(logs).toEqual(OPS_STEPS.map(step => `drive-ops ${step} ok`));
    for (const line of logs) expect(line).toMatch(VALUE_FREE_LINE);
  });

  it('logs skipped for absent ports and still runs the rest', async () => {
    const logs: string[] = [];
    const results = await runOpsTick({ reap: async () => undefined }, { lease: 'L', log: line => logs.push(line) });
    expect(results).toEqual({ restock: 'skipped', reap: 'ok', 'metrics-export': 'skipped', 'fixfwd-triage': 'skipped', 'dashboard-rollup': 'skipped' });
    expect(logs.every(line => VALUE_FREE_LINE.test(line))).toBe(true);
  });

  it('keeps advisory failures to one logged line and carries on; reap failure aborts the tick', async () => {
    const logs: string[] = [];
    const ran: string[] = [];
    const results = await runOpsTick({
      restock: async () => { throw new Error('boom'); },
      reap: async () => { ran.push('reap'); },
      metricsExport: async () => { ran.push('metrics'); },
    }, { lease: 'L', log: line => logs.push(line) });
    expect(results.restock).toBe('failed');
    expect(ran).toEqual(['reap', 'metrics']);
    expect(logs[0]).toBe('drive-ops restock failed');

    await expect(runOpsTick({ reap: async () => { throw new Error('reap boom'); } },
      { lease: 'L', log: line => logs.push(line) })).rejects.toThrow('reap boom');
    expect(logs.at(-1)).toBe('drive-ops reap failed');
  });

  it('marks unrun steps held when the tick signal is aborted', async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    const results = await runOpsTick({
      restock: async () => { controller.abort(); },
    }, { lease: 'L', log: line => logs.push(line), signal: controller.signal });
    expect(results.restock).toBe('ok');
    expect(results.reap).toBe('held');
    expect(results['dashboard-rollup']).toBe('held');
    expect(logs).toContain('drive-ops reap held');
  });
});

describe('dispatchd tick integration', () => {
  it('runs each moved step inside the tick under the shared lease with no Grok turn', async () => {
    const f = fixture([job('c1', 'READY', 'codex-cmp', 5)]);
    const order: string[] = [];
    f.deps.ops = {
      restock: async ctx => { expect(ctx.lease).toBe('lease'); order.push('restock'); },
      metricsExport: async () => { order.push('metrics-export'); },
      fixfwdTriage: async () => { order.push('fixfwd-triage'); },
      dashboardRollup: async () => { order.push('dashboard-rollup'); },
    };
    const report = await driveTick(f.deps);
    // Steps ran in order inside the tick, before planning/launch.
    expect(order).toEqual(['restock', 'metrics-export', 'fixfwd-triage', 'dashboard-rollup']);
    expect(f.calls).toEqual(['acquire', 'reap', 'launch:c1', 'status', 'release']);
    expect(report.ops).toEqual({ restock: 'ok', reap: 'ok', 'metrics-export': 'ok', 'fixfwd-triage': 'ok', 'dashboard-rollup': 'ok' });
    // The host's own dashboardRollup port replaced the default report staging.
    expect(report.dashboard).toBeUndefined();
    expect(report.launched).toEqual(['c1']);
    // Each moved step logged exactly one value-free line; no Grok turn was
    // spent — the only launch is the planned Codex job, never an ops step.
    const stepLines = f.logs.filter(line => line.startsWith('drive-ops '));
    expect(stepLines).toEqual(OPS_STEPS.map(step => `drive-ops ${step} ok`));
    for (const line of stepLines) expect(line).toMatch(VALUE_FREE_LINE);
    expect(f.bridge.launch).toHaveBeenCalledTimes(1);
    expect(f.bridge.launch).toHaveBeenCalledWith('lease', 'c1');
  });

  it('pauses non-P0 Grok-turn launches above 85 percent of the weekly pool', async () => {
    const f = fixture([
      job('low-grok', 'READY', 'grok-build', 3),
      job('p0-grok', 'READY', 'grok-build', P0_PRIORITY),
      job('codex-job', 'READY', 'codex-cmp', 3),
    ]);
    f.state.maxRunning = 3;
    f.deps.weeklyGrokUsedPercent = async () => 90;
    const report = await driveTick(f.deps);
    expect(report.governor).toBe('paused');
    expect(report.launched.sort()).toEqual(['codex-job', 'p0-grok']);
    expect(report.governorHeld).toEqual(['low-grok']);
    expect(f.logs).toContain('drive-ops governor paused');
  });

  it('launches all eligible work under the watermark', async () => {
    const f = fixture([
      job('low-grok', 'READY', 'grok-build', 3),
      job('codex-job', 'READY', 'codex-cmp', 3),
    ]);
    f.deps.weeklyGrokUsedPercent = async () => 50;
    const report = await driveTick(f.deps);
    expect(report.governor).toBe('open');
    expect(report.launched.sort()).toEqual(['codex-job', 'low-grok']);
    expect(report.governorHeld).toBeUndefined();
  });

  it('fails closed when the weekly reading is unavailable', async () => {
    const f = fixture([job('low-grok', 'READY', 'grok-build', 3), job('p0', 'READY', 'grok-build', P0_PRIORITY)]);
    f.deps.weeklyGrokUsedPercent = async () => null;
    const report = await driveTick(f.deps);
    expect(report.governor).toBe('unknown');
    expect(report.launched).toEqual(['p0']);
    expect(f.logs).toContain('drive-ops governor unknown');
  });

  it('stages a value-free dashboard rollup by default, with governor state when wired', async () => {
    const f = fixture([job('held', 'READY', 'grok-build', 3), job('p0', 'READY', 'grok-build', P0_PRIORITY)]);
    f.deps.weeklyGrokUsedPercent = async () => 95;
    const report = await driveTick(f.deps);
    expect(report.ops?.['dashboard-rollup']).toBe('ok');
    expect(report.dashboard).toMatchObject({
      schema: 'drive-ops-rollup.v1', admission: 'open', governor: 'paused',
      states: { READY: 2, RUNNING: 0 },
      pools: [
        { id: 'grok-build', active: 0, ceiling: 2 },
        { id: 'codex-cmp', active: 0, ceiling: 2 },
      ],
      ops: { restock: 'skipped', reap: 'ok', 'metrics-export': 'skipped', 'fixfwd-triage': 'skipped' },
    });
    // p0 launched after the rollup was staged.
    expect(report.launched).toEqual(['p0']);
    expect(JSON.stringify(report.dashboard)).not.toMatch(/held|p0/);
  });

  it('does not run the ops tick on dry-run or when ownership is busy', async () => {
    const f = fixture();
    f.deps.ops = { restock: async () => { throw new Error('must not run'); } };
    const dry = await driveTick(f.deps, { dryRun: true });
    expect(dry.ops).toBeUndefined();
    expect(f.logs).toEqual([]);

    f.bridge.acquire = vi.fn(async () => null);
    const busy = await driveTick(f.deps);
    expect(busy.held).toBe('ownership-busy');
    expect(busy.ops).toBeUndefined();
    expect(f.logs).toEqual([]);
  });
});
