/**
 * Optimizing coding-pool scheduler. Hermetic: temp files only, no home
 * directory, no network, no merge authority.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { roleAllowed } from '../src/core/routing/backend-roles.js';
import {
  embeddedSchedulerConfig,
  loadSchedulerConfig,
  parseSchedulerConfig,
} from '../src/core/providers/coding-cli/scheduler/defaults.js';
import {
  canaryBucket,
  emptyBandit,
  evaluatePolicy,
  expectedValue,
  promoteIfBetter,
  sampleValue,
  updateBandit,
  mulberry32,
  priorArm,
} from '../src/core/providers/coding-cli/scheduler/learn.js';
import { appendRouterDecision, readRouterDecisions } from '../src/core/providers/coding-cli/scheduler/log.js';
import { projectUltra } from '../src/core/providers/coding-cli/scheduler/pools.js';
import { computeRegret, regretBacklog, writeRegretBacklog } from '../src/core/providers/coding-cli/scheduler/regret.js';
import { runDrainTick } from '../src/core/providers/coding-cli/scheduler/drain.js';
import { schedule, type ScheduleInput } from '../src/core/providers/coding-cli/scheduler/solve.js';
import { createPosthogSink, createTelemetry, eventsFromSchedule } from '../src/core/providers/coding-cli/scheduler/telemetry.js';
import { armKey, SCHEDULER_POOL_IDS, type RouterOutcome, type SchedulerJob } from '../src/core/providers/coding-cli/scheduler/types.js';
import { runRouterCli } from '../src/cli/router.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');

function job(partial: Partial<SchedulerJob> & Pick<SchedulerJob, 'id'>): SchedulerJob {
  return { jobType: 'coding', ...partial };
}

function input(partial: Partial<ScheduleInput> & Pick<ScheduleInput, 'jobs'>): ScheduleInput {
  const { overrides, ...rest } = partial;
  return {
    nowMs: NOW,
    seed: 1,
    ...rest,
    overrides: { solverBudgetMs: 5_000, ...overrides },
  };
}

describe('scheduler config', () => {
  it('loads the Oct 25 Grok Ultra reading and a live claude pool', () => {
    const config = loadSchedulerConfig();
    const embedded = embeddedSchedulerConfig();
    expect(config.grokUltraWeekly.usedFraction).toBe(0.36);
    expect(config.grokUltraWeekly.usedFraction).toBe(embedded.grokUltraWeekly.usedFraction);
    expect(config.grokUltraWeekly.separateCursorCloudPool).toBe(false);
    expect(config.grokUltraWeekly.extraUsageCredits).toBe(false);
    expect(config.grokUltraWeekly.quotaReadableFromApi).toBe(false);
    expect(config.grokUltraWeekly.estimate).toBe(true);
    expect(config.grokUltraWeekly.orchestrationReserveFraction).toBe(0.15);
    expect(config.grokUltraWeekly.resetEveryDays).toBe(7);
    expect(Date.parse(config.grokUltraWeekly.resetAt)).toBe(Date.parse('2026-11-01T20:21:00-05:00'));
    expect(Date.parse(config.grokUltraWeekly.usedFractionAsOf)).toBe(Date.parse('2026-10-25T23:26:00-04:00'));
    expect(config.pools.claude.live).toBe(true);
    expect(config.source).toContain('Mason, Oct 25 2026 11:26 PM ET');
    expect(SCHEDULER_POOL_IDS).not.toContain('cursor-cloud');
    expect(SCHEDULER_POOL_IDS).not.toContain('grokbot');
    expect(config.postIssues).toBe(false);
    expect(config.diskFloorGb).toBe(20);
    expect(config.batteryFloorPercent).toBe(30);
    expect(config.canaryPercent).toBe(10);
  });

  it('keeps the posting flag off and accepts overrides', () => {
    const config = parseSchedulerConfig(JSON.stringify({
      postIssues: true,
      grokUltraWeekly: { usedFraction: 0.1, orchestrationReserveFraction: 0.2 },
      pools: { claude: { live: true, concurrency: 3 } },
    }));
    expect(config.postIssues).toBe(false);
    expect(config.grokUltraWeekly.usedFraction).toBe(0.1);
    expect(config.grokUltraWeekly.orchestrationReserveFraction).toBe(0.2);
    expect(config.pools.claude.concurrency).toBe(3);
    expect(() => parseSchedulerConfig('{"pools":{"cursor-cloud":{}}}')).toThrow(/unknown pool/);
  });
});

describe('grok ultra estimate', () => {
  const config = embeddedSchedulerConfig();

  it('keeps the snapshot inside the window and splits later usage', () => {
    const projected = projectUltra(config, [
      { ts: '2026-10-26T00:00:00.000Z', consumer: 'cloud-agent', fraction: 0.5 },
      { ts: '2026-10-26T11:00:00.000Z', consumer: 'orchestrator', fraction: 0.02 },
      { ts: '2026-10-26T11:30:00.000Z', consumer: 'cloud-agent', fraction: 0.01 },
    ], NOW);
    expect(projected.estimate).toBe(true);
    expect(projected.quotaReadableFromApi).toBe(false);
    expect(projected.unsplitUsedFraction).toBe(0.36);
    expect(projected.orchestrator).toBeCloseTo(0.02);
    expect(projected.cloudAgent).toBeCloseTo(0.01);
    expect(projected.usedFraction).toBeCloseTo(0.39);
    expect(projected.remaining).toBeCloseTo(0.61);
    expect(projected.label).toContain('estimate');
  });

  it('drops the snapshot after the weekly reset', () => {
    const after = Date.parse('2026-11-03T00:00:00.000Z');
    const projected = projectUltra(config, [
      { ts: '2026-10-26T13:00:00.000Z', consumer: 'cloud-agent', fraction: 0.2 },
      { ts: '2026-11-02T12:00:00.000Z', consumer: 'orchestrator', fraction: 0.05 },
    ], after);
    expect(projected.unsplitUsedFraction).toBe(0);
    expect(projected.orchestrator).toBeCloseTo(0.05);
    expect(projected.cloudAgent).toBe(0);
    expect(projected.remaining).toBeCloseTo(0.95);
    expect(projected.resetAtMs).toBe(Date.parse('2026-11-02T01:21:00.000Z') + 7 * 86_400_000);
  });
});

describe('milp assignment', () => {
  it('spends codex-primary before the other positive pools', async () => {
    const result = await schedule(input({ jobs: [job({ id: 'a' })] }));
    expect(result.status).toBe('optimal');
    expect(result.solver).toBe('highs');
    expect(result.assignments).toEqual([
      expect.objectContaining({ jobId: 'a', poolId: 'codex-primary', consumer: null, grantsMergeAuthority: false }),
    ]);
  });

  it('is deterministic for the same inputs', async () => {
    const first = await schedule(input({ jobs: [job({ id: 'a' }), job({ id: 'b', jobType: 'research' })] }));
    const second = await schedule(input({ jobs: [job({ id: 'a' }), job({ id: 'b', jobType: 'research' })] }));
    expect(second.assignments).toEqual(first.assignments);
    expect(second.unassigned).toEqual(first.unassigned);
  });

  it('keeps one job per concurrency slot and one unit of known quota', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'a' }), job({ id: 'b' })],
      overrides: {
        solverBudgetMs: 5_000,
        pools: {
          'codex-primary': { concurrency: 1, remaining: 1 },
          'codex-secondary': { enabled: false },
          claude: { enabled: false },
          local: { enabled: false },
        },
      },
    }));
    expect(result.assignments.filter((row) => row.poolId === 'codex-primary')).toHaveLength(1);
    expect(result.unassigned).toHaveLength(1);
  });

  it('prefers a pool that expires inside the week', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'a' })],
      overrides: {
        solverBudgetMs: 5_000,
        loseItWeight: 0.5,
        pools: {
          'codex-secondary': { expiresAt: new Date(NOW + 3_600_000).toISOString(), remaining: 5 },
          'codex-primary': { remaining: 5 },
        },
      },
    }));
    expect(result.assignments[0]?.poolId).toBe('codex-secondary');
  });

  it('blocks Mac pools below the disk or battery floor', async () => {
    const disk = await schedule(input({
      jobs: [job({ id: 'a' })],
      host: { diskFreeGb: 19, batteryPercent: 90 },
    }));
    const battery = await schedule(input({
      jobs: [job({ id: 'a' })],
      host: { diskFreeGb: 40, batteryPercent: 29 },
    }));
    expect(disk.assignments).toEqual([]);
    expect(battery.assignments).toEqual([]);
    expect(disk.unassigned).toEqual(['a']);
  });

  it('does not give merge or credential work to a subscription, local, or loopback pool', async () => {
    const merge = await schedule(input({
      jobs: [job({ id: 'merge', jobType: 'merge-decision' })],
    }));
    const credential = await schedule(input({
      jobs: [job({ id: 'cred', role: 'credential', jobType: 'coding' })],
    }));
    expect(merge.assignments).toEqual([
      expect.objectContaining({ poolId: 'grok-ultra-weekly', consumer: 'orchestrator', grantsMergeAuthority: false }),
    ]);
    expect(credential.assignments).toEqual([]);
    expect(roleAllowed('subscription', 'merge')).toBe(false);
    expect(roleAllowed('local', 'merge')).toBe(false);
    expect(roleAllowed('loopback', 'credential')).toBe(false);
    expect(roleAllowed('metered', 'credential')).toBe(false);
  });

  it('holds the orchestration reserve and paces cloud agents', async () => {
    const wideOpen = {
      solverBudgetMs: 5_000,
      paceTickMs: 8 * 86_400_000,
      pools: {
        'codex-primary': { enabled: false },
        'codex-secondary': { enabled: false },
        claude: { enabled: false },
        local: { enabled: false },
        devin: { enabled: false },
        'grok-build': { enabled: false },
        metered: { enabled: false },
      },
    };
    const valued = (value: number) => () => value;
    const reserved = await schedule(input({
      jobs: [job({ id: 'cloud', quotaByPool: { 'grok-ultra-weekly': 0.6 } })],
      overrides: wideOpen,
      valueOverride: valued(1),
    }));
    expect(reserved.assignments).toEqual([]);
    const paced = await schedule(input({
      jobs: [job({ id: 'cloud', quotaByPool: { 'grok-ultra-weekly': 0.2 } })],
      overrides: { ...wideOpen, paceTickMs: 86_400_000 },
      valueOverride: valued(1),
    }));
    expect(paced.assignments).toEqual([]);
    expect(paced.ultra.remaining).toBeGreaterThan(0);
    const fits = await schedule(input({
      jobs: [job({ id: 'cloud', quotaByPool: { 'grok-ultra-weekly': 0.05 } })],
      overrides: { ...wideOpen, paceTickMs: 86_400_000 },
      valueOverride: valued(1),
    }));
    expect(fits.assignments[0]).toEqual(expect.objectContaining({
      poolId: 'grok-ultra-weekly',
      consumer: 'cloud-agent',
    }));
    expect(fits.runwayHours).toBeGreaterThan(0);
  });

  it('ranks a cloud agent after local when both can take the job', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'a' })],
      overrides: {
        solverBudgetMs: 5_000,
        pools: {
          'codex-primary': { enabled: false },
          'codex-secondary': { enabled: false },
          claude: { enabled: false },
          devin: { enabled: false },
          'grok-build': { enabled: false },
        },
      },
      valueOverride: () => 1,
    }));
    expect(result.assignments[0]?.poolId).toBe('local');
  });

  it('stops an unknown balance at the daily soft cap', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'a' })],
      overrides: {
        solverBudgetMs: 5_000,
        pools: {
          'codex-primary': { remaining: null, usedToday: 1, softCapPerDay: 1 },
          'codex-secondary': { enabled: false },
          claude: { enabled: false },
          local: { enabled: false },
        },
      },
    }));
    expect(result.assignments).toEqual([]);
  });

  it('reports an infeasible required assignment without the greedy fallback', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'stuck', role: 'credential', requireAssignment: true })],
    }));
    expect(result.status).toBe('infeasible');
    expect(result.solver).toBe('highs');
    expect(result.fallbackReason).toBeNull();
    expect(result.assignments).toEqual([]);
  });

  it('falls back to greedy spend order when the solver throws or times out', async () => {
    const jobs = [job({ id: 'a' })];
    const overrides = {
      solverBudgetMs: 5_000,
      pools: {
        'codex-primary': { headroomPercent: 10, remaining: 5 },
        'codex-secondary': { headroomPercent: 90, remaining: 5 },
      },
    };
    const thrown = await schedule(input({
      jobs,
      overrides,
      solver: () => { throw new Error('solver down'); },
    }));
    const timedOut = await schedule(input({
      jobs,
      overrides,
      solver: async () => ({ status: 'timeout', objective: null, values: {} }),
    }));
    expect(thrown.status).toBe('fallback');
    expect(thrown.fallbackReason).toBe('failed');
    expect(thrown.assignments[0]?.poolId).toBe('codex-secondary');
    expect(timedOut.fallbackReason).toBe('timeout');
    expect(timedOut.assignments[0]?.poolId).toBe('codex-secondary');
    const solved = await schedule(input({ jobs, overrides }));
    expect(solved.assignments[0]?.poolId).toBe('codex-primary');
  });
});

describe('bandit, replay, and regret', () => {
  const config = embeddedSchedulerConfig();

  it('updates from green merges, review rounds, reverts, tokens, and wall time', () => {
    const outcome: RouterOutcome = {
      ts: '2026-10-26T12:00:00.000Z',
      jobId: 'a',
      jobType: 'coding',
      poolId: 'codex-primary',
      consumer: null,
      merged: true,
      green: true,
      reviewRounds: 1,
      reverted: false,
      tokens: 4_000,
      wallMs: 30_000,
      cost: 0,
      propensity: 1,
    };
    const updated = updateBandit(emptyBandit(), outcome);
    const arm = updated.arms[armKey('coding', 'codex-primary', null)];
    expect(arm?.alpha).toBe(2);
    expect(arm?.beta).toBe(1);
    expect(arm?.qualityMean).toBeCloseTo(0.5);
    expect(arm?.latencyMean).toBe(30_000);
    expect(arm?.tokenMean).toBe(4_000);
    const reverted = updateBandit(emptyBandit(), { ...outcome, reverted: true, merged: true, green: true });
    expect(reverted.arms[armKey('coding', 'codex-primary', null)]?.beta).toBe(2);
  });

  it('draws the same Thompson sample for the same seed', () => {
    const arm = priorArm();
    const first = sampleValue(arm, mulberry32(7), config);
    const second = sampleValue(arm, mulberry32(7), config);
    expect(second).toBe(first);
    const buckets = Array.from({ length: 1000 }, (_, index) => canaryBucket(`job-${index}`, '1'));
    const canaries = buckets.filter((bucket) => bucket < 10).length;
    expect(canaries).toBeGreaterThan(70);
    expect(canaries).toBeLessThan(130);
    expect(canaryBucket('job-1', '1')).toBe(canaryBucket('job-1', '1'));
  });

  it('promotes a candidate only when doubly robust replay is better', () => {
    const strong = { ...priorArm(), alpha: 50, beta: 1, observations: 50, qualityMean: 1 };
    const weak = { ...priorArm(), alpha: 1, beta: 50, observations: 50, qualityMean: 0 };
    const incumbent = {
      id: 'incumbent',
      arms: {
        [armKey('coding', 'local', null)]: strong,
        [armKey('coding', 'codex-primary', null)]: weak,
      },
    };
    const candidate = {
      id: 'candidate',
      arms: {
        [armKey('coding', 'local', null)]: weak,
        [armKey('coding', 'codex-primary', null)]: strong,
      },
    };
    const rows = [{
      jobType: 'coding' as const,
      loggedPool: 'codex-primary' as const,
      loggedConsumer: null,
      propensity: 1,
      reward: 1,
      eligible: [
        { poolId: 'codex-primary' as const, consumer: null },
        { poolId: 'local' as const, consumer: null },
      ],
    }, {
      jobType: 'coding' as const,
      loggedPool: 'codex-primary' as const,
      loggedConsumer: null,
      propensity: 1,
      reward: 1,
      eligible: [
        { poolId: 'codex-primary' as const, consumer: null },
        { poolId: 'local' as const, consumer: null },
      ],
    }];
    const promoted = promoteIfBetter({ incumbent, candidate, rows, config, minRows: 2 });
    expect(promoted.promoted).toBe(true);
    expect(promoted.method).toBe('doubly-robust');
    expect(promoted.candidateScore).toBeGreaterThan(promoted.incumbentScore);
    expect(promoted.policy.id).toBe('candidate');
    const blocked = promoteIfBetter({ incumbent: candidate, candidate: incumbent, rows, config, minRows: 2 });
    expect(blocked.promoted).toBe(false);
    expect(blocked.reason).toBe('replay did not beat the incumbent');
    expect(promoteIfBetter({ incumbent, candidate, rows: rows.slice(0, 1), config, minRows: 2 }).reason).toBe('too few rows');
    expect(evaluatePolicy(rows, candidate, config).ips).toBeGreaterThan(0);
    expect(expectedValue(priorArm(), config)).toBeGreaterThan(0);
  });

  it('writes regret to a local backlog and does not post', () => {
    const failed = updateBandit(emptyBandit(), {
      ts: NOW_ISO(), jobId: 'a', jobType: 'coding', poolId: 'local', consumer: null,
      merged: false, green: false, reviewRounds: 3, reverted: true, tokens: 10, wallMs: 50_000, cost: null, propensity: 1,
    });
    const items = computeRegret({
      outcomes: [{
        ts: NOW_ISO(), jobId: 'a', jobType: 'coding', poolId: 'local', consumer: null,
        merged: false, green: false, reviewRounds: 3, reverted: true, tokens: 10, wallMs: 50_000, cost: null, propensity: 1,
      }],
      bandit: failed,
      config,
    });
    expect(items[0]?.chosenPool).toBe('local');
    expect(items[0]?.regret).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), 'router-regret-'));
    const file = join(dir, 'backlog.json');
    writeRegretBacklog(file, { ...regretBacklog(items, NOW_ISO()), postIssues: false });
    const written = JSON.parse(readFileSync(file, 'utf8')) as { postIssues: boolean; items: unknown[] };
    expect(written.postIssues).toBe(false);
    expect(written.items).toHaveLength(items.length);
  });
});

describe('decision log, telemetry, and drain', () => {
  it('appends decisions, skips a bad line, and scrubs secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-log-'));
    const file = join(dir, 'decisions.jsonl');
    const row = {
      ts: NOW_ISO(),
      jobId: 'job-sk-abcdefghijklmnopqrstuvwxyz',
      jobType: 'coding' as const,
      poolId: 'codex-primary' as const,
      consumer: null,
      policyId: 'incumbent',
      canary: false,
      propensity: 1,
      solver: 'highs' as const,
      fallback: false,
      grantsMergeAuthority: false as const,
      netValue: 0.5,
      eligible: [{ poolId: 'codex-primary' as const, consumer: null }],
    };
    appendRouterDecision(file, row);
    const first = readFileSync(file, 'utf8');
    appendRouterDecision(file, { ...row, jobId: 'second' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}not json\n`, 'utf8');
    expect(readFileSync(file, 'utf8').startsWith(first)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    const rows = readRouterDecisions(file);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.jobId).toBe('second');
    expect(rows[0]?.grantsMergeAuthority).toBe(false);
  });

  it('emits burn-down, runway, and value only when telemetry is enabled', async () => {
    const result = await schedule(input({
      jobs: [job({ id: 'a' })],
      overrides: {
        solverBudgetMs: 5_000,
        pools: {
          'codex-primary': { enabled: false },
          'codex-secondary': { enabled: false },
          claude: { enabled: false },
          local: { enabled: false },
          devin: { enabled: false },
          'grok-build': { enabled: false },
          'grok-ultra-weekly': { enabled: false },
          metered: { monetaryCost: 1, requiresMeteredOptIn: false },
        },
      },
      meteredEnabled: true,
      valueOverride: () => 2,
    }));
    const off = createTelemetry({ enabled: false, sink: () => { throw new Error('sink called'); } });
    off.emit(eventsFromSchedule(result, NOW)[0]!);
    expect(off.events).toEqual([]);
    const seen: string[] = [];
    const on = createTelemetry({ enabled: true, sink: (event) => { seen.push(event.event); } });
    for (const event of eventsFromSchedule(result, NOW)) on.emit(event);
    expect(seen).toContain('phantom_pool_burndown');
    expect(seen).toContain('phantom_grok_ultra_runway');
    expect(seen).toContain('phantom_pool_value_per_dollar');
    const value = on.events.find((event) => event.event === 'phantom_pool_value_per_dollar');
    expect(value?.properties['value_per_dollar']).toEqual(expect.any(Number));
    const calls: string[] = [];
    const sink = createPosthogSink({
      host: 'https://us.i.posthog.com',
      apiKey: 'phc_test',
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response('{}');
      }) as typeof fetch,
    });
    sink(eventsFromSchedule(result, NOW)[0]!);
    expect(calls).toEqual(['https://us.i.posthog.com/capture/']);
  });

  it('drains a queue without spawning or merging', async () => {
    const result = await runDrainTick({
      nowMs: NOW,
      jobs: [job({ id: 'boxed', jobType: 'investigation' })],
      overrides: { solverBudgetMs: 5_000 },
      classify: async () => { throw new Error('Jev must not be called when jobs are already shaped'); },
    });
    expect(result.spawned).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.assignments[0]?.poolId).toBe('codex-primary');
    expect(result.decisions[0]?.grantsMergeAuthority).toBe(false);
  });
});

describe('phm router regret', () => {
  it('writes the backlog and ignores a posting flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-cli-'));
    const ledger = join(dir, 'outcomes.jsonl');
    const backlog = join(dir, 'backlog.json');
    writeFileSync(ledger, `${JSON.stringify({
      ts: NOW_ISO(), jobId: 'a', jobType: 'coding', poolId: 'local', consumer: null,
      merged: false, green: false, reviewRounds: 4, reverted: true, tokens: null, wallMs: 10, cost: null, propensity: 1,
    })}\n`, 'utf8');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await runRouterCli(['regret', '--ledger', ledger, '--backlog', backlog, '--post-issues', '--json']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('posting flag stays off'));
    error.mockRestore();
    log.mockRestore();
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(backlog, 'utf8')) as { postIssues: boolean; items: { regret: number }[] };
    expect(written.postIssues).toBe(false);
    expect(written.items[0]?.regret).toBeGreaterThan(0);
  });
});

function NOW_ISO(): string {
  return new Date(NOW).toISOString();
}
