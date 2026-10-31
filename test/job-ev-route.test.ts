import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyJobTemplate,
  parseRouteJobSpec,
  poolAdmits,
  poolPressureFromPlan,
  poolPressureFromSnapshot,
  RouteInputError,
  routeJobExpectedValue,
  routePriorsFromMetrics,
  type PoolPressure,
  type RouteJobSpec,
  type RoutePrior,
  type RoutePriors,
} from '../src/core/fleet/job-ev-route.js';
import { cmdRoute } from '../src/cli/route.js';
import { BUDGET_POOLS, type BudgetPool } from '../src/core/fleet/pool-budget.js';
import { DEFAULT_LOCAL_MODEL_TAG } from '../src/core/run/model-catalog.js';

const open: PoolPressure = { state: 'open', reason: 'test' };
const openPools = (over: Partial<Record<BudgetPool, PoolPressure>> = {}): Partial<Record<BudgetPool, PoolPressure>> =>
  Object.fromEntries([...BUDGET_POOLS.map((p): [BudgetPool, PoolPressure] => [p, open]), ...Object.entries(over)]);

const prior = (over: Partial<RoutePrior>): RoutePrior => ({
  mergeRate: null, emptyJobRate: null, tokensPerMergedPR: null,
  mergedImpactPerToken: null, completedJobs: 10, ...over,
});

const route = (spec: RouteJobSpec, priors: RoutePriors = {}, pressure = openPools()) =>
  routeJobExpectedValue(spec, { priors, pressure });

// ---------------------------------------------------------------------------
// Acceptance: mechanical -> local, hard Tier-1 -> frontier, over-pace avoided
// ---------------------------------------------------------------------------

describe('per-job EV routing acceptance', () => {
  it('routes a mechanical job to the local oMLX pool', () => {
    for (const spec of [
      { id: 'RQ-M1', task: 'Rebase the branch, run prettier and fix lint.' },
      { id: 'RQ-M2', template: 'docs' },
      { id: 'RQ-M3', task: 'Update the README changelog entries.' },
    ]) {
      const decision = route(spec);
      expect(decision.action).toBe('route');
      expect(decision.pool).toBe('local-omlx');
      expect(decision.tier).toBe('local');
      expect(decision.model).toBe(DEFAULT_LOCAL_MODEL_TAG);
      expect(decision.template).toBe('mechanical');
    }
  });

  it('keeps mechanical work local even when a frontier arm measures better', () => {
    const priors = {
      laneTiers: {
        'devin/frontier': prior({ mergedImpactPerToken: 0.9 }),
        'local-omlx/local': prior({ mergedImpactPerToken: 0.001 }),
      },
    };
    const decision = route({ id: 'RQ-M4', template: 'formatting' }, priors);
    expect(decision.pool).toBe('local-omlx');
    expect(decision.expectedImpactPerToken).toBe(0.001);
  });

  it('holds a mechanical job rather than upgrading it when local capacity is zero', () => {
    const decision = route(
      { id: 'RQ-M5', template: 'rebase' },
      {},
      openPools({ 'local-omlx': { state: 'paused', reason: 'Observed capacity is zero.' } }),
    );
    expect(decision.action).toBe('hold');
    expect(decision.pool).toBeNull();
    expect(decision.excluded).toContainEqual(
      expect.objectContaining({ pool: 'local-omlx', reason: 'paused: Observed capacity is zero.' }),
    );
  });

  it('routes a hard Tier-1 job to a frontier arm', () => {
    const priors = {
      laneTiers: {
        'devin/frontier': prior({ mergedImpactPerToken: 0.05 }),
        'codex-cmp/frontier': prior({ mergedImpactPerToken: 0.02 }),
        'local-omlx/local': prior({ mergedImpactPerToken: 0.9 }),
      },
    };
    for (const spec of [
      { id: 'RQ-H1', riskTier: 1 as const, task: 'touch auth config' },
      { id: 'RQ-H2', difficulty: 'high' as const },
      { id: 'RQ-H3', task: 'migration of the billing ledger', expectedImpact: 80 },
    ]) {
      const decision = route(spec, priors);
      expect(decision.action).toBe('route');
      expect(decision.template).toBe('hard');
      expect(decision.tier).toBe('frontier');
      expect(decision.pool).toBe('devin');
      // The better-measured local arm must be excluded, never win.
      expect(decision.excluded.some((e) => e.pool === 'local-omlx')).toBe(true);
    }
  });

  it('avoids an over-pace pool and routes to the next-best frontier arm', () => {
    const priors = {
      laneTiers: {
        'devin/frontier': prior({ mergedImpactPerToken: 0.05 }),
        'codex-cmp/frontier': prior({ mergedImpactPerToken: 0.02 }),
      },
    };
    const spec = { id: 'RQ-P1', difficulty: 'high' as const };
    expect(route(spec, priors).pool).toBe('devin');
    const decision = route(spec, priors, openPools({
      devin: { state: 'over-pace', paceRatio: 2.4, reason: 'Over pace: observed burn above target.' },
    }));
    expect(decision.pool).toBe('codex-cmp');
    expect(decision.excluded).toContainEqual(
      expect.objectContaining({ pool: 'devin', reason: 'over pace: Over pace: observed burn above target.' }),
    );
  });

  it('holds when every eligible arm is pressure-blocked', () => {
    const frontier = ['codex-cmp', 'codex-personal', 'claude', 'devin', 'grok-ultra'] as const;
    const pressure = openPools(Object.fromEntries(
      frontier.map((p): [BudgetPool, PoolPressure] => [p, { state: 'over-pace', reason: 'over' }]),
    ));
    const decision = route({ id: 'RQ-P2', riskTier: 1 }, {}, pressure);
    expect(decision.action).toBe('hold');
    // Five frontier arms blocked by pressure, two blocked by the tier guard.
    expect(decision.excluded).toHaveLength(frontier.length + 2);
    expect(decision.excluded.filter((e) => e.reason.startsWith('over pace'))).toHaveLength(frontier.length);
  });
});

// ---------------------------------------------------------------------------
// EV ranking and priors
// ---------------------------------------------------------------------------

describe('expected merged impact per token ranking', () => {
  it('cold-start orders a standard job to mid tier first', () => {
    const decision = route({ id: 'RQ-C1', task: 'implement a small feature' });
    expect(decision.pool).toBe('grok-build');
    expect(decision.tier).toBe('mid');
    expect(decision.priorBasis).toBe('cold-start');
  });

  it('a measured prior outranks the cold-start ordering', () => {
    const priors = { tiers: { local: prior({ mergedImpactPerToken: 0.4 }) } };
    const decision = route({ id: 'RQ-C2', task: 'implement a small feature' }, priors);
    expect(decision.pool).toBe('local-omlx');
    expect(decision.priorBasis).toBe('tier local');
    expect(decision.expectedImpactPerToken).toBe(0.4);
  });

  it('derives EV as impact over tokens-per-merge without double-counting merges', () => {
    // tokensPerMergedPR already divides by merges, so mergeRate is not applied again.
    const priors = {
      tiers: { mid: prior({ mergeRate: 0.5, tokensPerMergedPR: 100_000 }) },
      overall: prior({ mergedImpactPerToken: 0.000_05 }),
    };
    const decision = route({ id: 'RQ-C3', expectedImpact: 10 }, priors);
    expect(decision.pool).toBe('grok-build');
    expect(decision.priorBasis).toBe('tier mid');
    expect(decision.expectedImpactPerToken).toBe(10 / 100_000);
  });

  it('prefers the most specific prior group: laneTier > template > tier > lane > overall', () => {
    const mk = (ev: number) => prior({ mergedImpactPerToken: ev });
    const priors = {
      laneTiers: { 'devin/frontier': mk(0.9) },
      templates: { standard: mk(0.8) },
      tiers: { frontier: mk(0.7) },
      lanes: { devin: mk(0.6) },
      overall: mk(0.5),
    };
    const decision = route({ id: 'RQ-C4', riskTier: 1 }, priors);
    expect(decision.pool).toBe('devin');
    expect(decision.priorBasis).toBe('laneTier devin/frontier');
    const noLaneTier = route({ id: 'RQ-C5', riskTier: 1 }, {
      templates: { standard: mk(0.8) }, // 'hard' template missing -> falls to tier
      tiers: { frontier: mk(0.7) },
    });
    expect(noLaneTier.priorBasis).toBe('tier frontier');
  });

  it('ignores prior groups under the minimum completed-job floor', () => {
    const priors = { laneTiers: { 'devin/frontier': prior({ mergedImpactPerToken: 0.99, completedJobs: 2 }) } };
    const decision = route({ id: 'RQ-C6', riskTier: 1 }, priors);
    expect(decision.priorBasis).toBe('cold-start');
    expect(decision.pool).toBe('codex-cmp'); // cheapest-first frontier arm on ties
  });

  it('does not echo task text into the decision', () => {
    const secret = 'hunter2-password-do-not-echo';
    const decision = route({ id: 'RQ-C7', task: `fix typo in docs ${secret}` });
    expect(JSON.stringify(decision)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Template classification
// ---------------------------------------------------------------------------

describe('job template classification', () => {
  it.each([
    [{ template: 'rebase' }, 'mechanical'],
    [{ template: 'TIER-1' }, 'hard'],
    [{ template: 'feature' }, 'standard'],
    [{ riskTier: 1 }, 'hard'],
    [{ difficulty: 'high' }, 'hard'],
    [{ expectedImpact: 40 }, 'hard'],
    [{ expectedImpact: 39.9 }, 'standard'],
    [{ task: 'rotate credentials and reformat the file' }, 'hard'], // hard beats mechanical keywords
    [{ task: 'sort imports and bump deps' }, 'mechanical'],
    [{ task: 'investigate flaky retry logic' }, 'standard'],
    [{}, 'standard'],
  ])('classifies %j as %s', (spec, expected) => {
    expect(classifyJobTemplate(spec as RouteJobSpec)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Budget pressure adapters
// ---------------------------------------------------------------------------

describe('plan pressure adapter', () => {
  const plan = (decisions: Record<string, unknown>, wrapper = true) =>
    poolPressureFromPlan(wrapper ? { plan: { schema: 'fleet.budget-plan.v1', tolerance: 0.1, decisions } } : { schema: 'fleet.budget-plan.v1', tolerance: 0.1, decisions });

  it('maps concurrency and lane states to pressure', () => {
    const pressure = plan({
      devin: { concurrency: 'lower', lane: 'metered', paceRatio: 2.1, reasons: ['Over pace.'] },
      'codex-cmp': { concurrency: 'pause', lane: 'weekly', reasons: ['Weekly lane closed.'] },
      claude: { concurrency: 'hold', lane: 'held' },
      'codex-personal': { concurrency: 'hold', lane: 'none' },
      'local-omlx': { concurrency: 'hold', lane: 'capacity', maxConcurrency: 0 },
      'grok-build': { concurrency: 'raise', lane: 'metered', paceRatio: 0.4 },
      'grok-ultra': { concurrency: 'hold', lane: 'metered', paceRatio: 1.2 },
    });
    expect(pressure.devin.state).toBe('over-pace');
    expect(pressure['codex-cmp'].state).toBe('paused');
    expect(pressure.claude.state).toBe('held');
    expect(pressure['codex-personal'].state).toBe('closed');
    expect(pressure['local-omlx'].state).toBe('closed');
    expect(pressure['grok-build'].state).toBe('open');
    expect(pressure['grok-ultra'].state).toBe('over-pace'); // paceRatio beyond tolerance
  });

  it('marks pools missing from the plan as unknown, which still admits', () => {
    const pressure = plan({});
    expect(pressure.devin.state).toBe('unknown');
    expect(poolAdmits(pressure.devin).admit).toBe(true);
  });

  it('rejects a document that is not a fleet.budget-plan', () => {
    expect(() => poolPressureFromPlan({ schema: 'fleet.budgets.v1' })).toThrow(RouteInputError);
    expect(() => poolPressureFromPlan('junk')).not.toThrow();
  });
});

describe('snapshot pressure fallback', () => {
  const snap = (pools: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    poolPressureFromSnapshot({ schema: 'fleet.budgets.v1', timestamp: '2026-10-25T12:00:00.000Z', sourceState: 'healthy', pools, ...extra });
  const metered = (buckets: Record<string, unknown>) => ({ mode: 'metered', buckets });
  const observed = (over: Record<string, unknown>) => ({ remaining: null, resetAt: null, state: 'observed', projectedExhaustion: null, ...over });

  it('reads held pools, zero capacity, exhausted and reset-pending lanes', () => {
    const pressure = snap({
      claude: { mode: 'held' },
      'local-omlx': { mode: 'capacity-only', buckets: { capacity: observed({ remaining: 0 }) } },
      'codex-cmp': metered({ weeklyPct: observed({ remaining: 0, resetAt: '2026-11-01T00:00:00.000Z' }) }),
      'codex-personal': metered({ weeklyPct: observed({ remaining: null, resetAt: '2026-10-25T06:00:00.000Z', state: 'reset-pending' }) }),
      'grok-build': metered({ acus: observed({ remaining: 40 }) }),
      'grok-ultra': metered({ acus: observed({ remaining: 10 }) }),
      devin: metered({ acus: observed({ remaining: 90 }) }),
    });
    expect(pressure.claude.state).toBe('held');
    expect(pressure['local-omlx'].state).toBe('paused');
    expect(pressure['codex-cmp'].state).toBe('paused');
    expect(pressure['codex-personal'].state).toBe('paused');
    expect(pressure['grok-build'].state).toBe('open');
    expect(pressure.devin.state).toBe('open');
  });

  it('flags over-pace only when the ledger projection is already behind now', () => {
    const pressure = snap({
      devin: metered({ acus: observed({ remaining: 3, projectedExhaustion: '2026-10-25T10:00:00.000Z' }) }),
      'grok-build': metered({ acus: observed({ remaining: 40, projectedExhaustion: '2026-10-25T20:00:00.000Z' }) }),
    });
    expect(pressure.devin.state).toBe('over-pace');
    expect(pressure['grok-build'].state).toBe('open'); // burning normally is not over pace
  });

  it('opens a credits lane once weekly is exhausted', () => {
    const pressure = snap({
      'codex-cmp': metered({
        weeklyPct: observed({ remaining: 0, resetAt: '2026-11-01T00:00:00.000Z' }),
        credits: observed({ remaining: 12 }),
      }),
    });
    expect(pressure['codex-cmp'].state).toBe('open');
    expect(pressure['codex-cmp'].lane).toBe('credits');
  });

  it('keeps every pool unknown when the ledger is unavailable', () => {
    const pressure = snap({}, { sourceState: 'unavailable' });
    for (const pool of BUDGET_POOLS) expect(pressure[pool].state).toBe('unknown');
  });

  it('rejects a document that is not a fleet.budgets snapshot', () => {
    expect(() => poolPressureFromSnapshot({ schema: 'fleet.budget-plan.v1' })).toThrow(RouteInputError);
  });
});

// ---------------------------------------------------------------------------
// Metrics feed adapter and input validation
// ---------------------------------------------------------------------------

describe('metrics feed adapter', () => {
  it('accepts both keyed maps and feed arrays', () => {
    const feed = {
      lanes: [{ key: 'devin', mergedImpactPerToken: 0.02, completedJobs: 9 }],
      laneTiers: { 'devin/frontier': { mergedImpactPerToken: 0.05, completedJobs: 4 } },
      overall: { mergedImpactPerToken: 0.01, completedJobs: 40 },
    };
    const priors = routePriorsFromMetrics(feed);
    expect(priors.lanes?.['devin']?.mergedImpactPerToken).toBe(0.02);
    expect(priors.laneTiers?.['devin/frontier']?.completedJobs).toBe(4);
    expect(priors.overall?.completedJobs).toBe(40);
  });

  it('accepts valuePerMTok from phm metrics rollups as impact per token', () => {
    const priors = routePriorsFromMetrics({ tiers: { local: { valuePerMTok: 400_000, completedJobs: 12 } } });
    expect(priors.tiers?.['local']?.mergedImpactPerToken).toBe(0.4);
  });

  it('drops unparseable rows instead of inventing measurements', () => {
    const priors = routePriorsFromMetrics({
      lanes: { devin: { mergedImpactPerToken: 'a lot' }, claude: null },
      tiers: [null, 42, { mergedImpactPerToken: 0.1 }], // no completedJobs -> dropped
      overall: 'junk',
    });
    expect(priors.lanes).toEqual({});
    expect(priors.tiers).toEqual({});
    expect(priors.overall).toBeUndefined();
    expect(routePriorsFromMetrics(null)).toEqual({});
  });
});

describe('job spec validation', () => {
  it.each([
    [null], [42], ['x'], [[]], [{}],
    [{ id: 'has spaces' }],
    [{ id: 'ok-1', repo: 'no-owner-slash-needed?' }],
    [{ id: 'ok-1', repo: 'a/b', riskTier: 0 }],
    [{ id: 'ok-1', difficulty: 'extreme' }],
    [{ id: 'ok-1', expectedImpact: -1 }],
    [{ id: 'ok-1', expectedImpact: NaN }],
    [{ id: 'ok-1', task: 'x'.repeat(8_001) }],
    [{ id: 'ok-1', task: 'bad\u0000byte' }],
  ])('rejects %j', (input) => {
    expect(() => parseRouteJobSpec(input)).toThrow(RouteInputError);
  });

  it('accepts a complete spec', () => {
    expect(parseRouteJobSpec({
      id: 'RQ-BUDGETJEVROUTEQ7', repo: 'ashlrai/phantom', task: 'route me',
      template: 'feature', riskTier: 2, difficulty: 'medium', expectedImpact: 12,
    })).toMatchObject({ id: 'RQ-BUDGETJEVROUTEQ7', repo: 'ashlrai/phantom', riskTier: 2 });
  });
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

async function* stdinOf(text: string) { yield text; }
const collect = () => { const lines: string[] = []; return { lines, push: (l: string) => { lines.push(l); } }; };

describe('phm route job', () => {
  it('routes a job from stdin with an injected budget ledger', async () => {
    const out = collect(); const err = collect();
    const ledger = { schema: 'fleet.budgets.v1', timestamp: '2026-10-25T12:00:00.000Z', sourceState: 'healthy', pools: {} };
    const code = await cmdRoute(['job', '--input', '-'], {
      stdin: stdinOf(JSON.stringify({ id: 'RQ-CLI1', template: 'docs' })),
      readBudgets: async () => ledger,
      out: out.push, err: err.push,
    });
    expect(code).toBe(0);
    expect(err.lines).toEqual([]);
    const decision = JSON.parse(out.lines.join('\n'));
    expect(decision.kind).toBe('job-route');
    expect(decision.pool).toBe('local-omlx');
    expect(decision.tier).toBe('local');
  });

  it('reads job, metrics and plan from files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-'));
    const jobPath = join(dir, 'job.json');
    const metricsPath = join(dir, 'metrics.json');
    const planPath = join(dir, 'plan.json');
    writeFileSync(jobPath, JSON.stringify({ id: 'RQ-CLI2', riskTier: 1 }));
    writeFileSync(metricsPath, JSON.stringify({ laneTiers: { 'devin/frontier': { mergedImpactPerToken: 0.05, completedJobs: 8 } } }));
    writeFileSync(planPath, JSON.stringify({ plan: { schema: 'fleet.budget-plan.v1', tolerance: 0.1, decisions: { 'local-omlx': { concurrency: 'pause', lane: 'capacity' } } } }));
    const out = collect(); const err = collect();
    const code = await cmdRoute(
      ['job', '--input', jobPath, '--metrics', metricsPath, '--plan', planPath, '--json'],
      { out: out.push, err: err.push },
    );
    expect(code).toBe(0);
    const decision = JSON.parse(out.lines.join('\n'));
    expect(decision.pool).toBe('devin');
    expect(decision.priorBasis).toBe('laneTier devin/frontier');
  });

  it('rejects two standard-input consumers and unknown flags', async () => {
    const err1 = collect();
    expect(await cmdRoute(['job', '--input', '-', '--plan', '-'], { stdin: stdinOf('{}'), err: err1.push })).toBe(2);
    expect(err1.lines[0]).toContain('only one input');
    expect(await cmdRoute(['job', '--input', '-', '--verbose'], { stdin: stdinOf('{}'), err: () => {} })).toBe(2);
    expect(await cmdRoute(['job'], { err: () => {} })).toBe(2);
    expect(await cmdRoute(['notjob'], { err: () => {} })).toBe(2);
  });

  it('exits 2 on invalid JSON without echoing input content', async () => {
    const err = collect();
    const code = await cmdRoute(['job', '--input', '-'], {
      stdin: stdinOf('{secret-task-text, not json'),
      readBudgets: async () => ({}), err: err.push,
    });
    expect(code).toBe(2);
    expect(err.lines.join('\n')).not.toContain('secret-task-text');
    expect(err.lines.join('\n')).toContain('Invalid JSON');
  });

  it('prints help on --help and no subcommand', async () => {
    const out = collect();
    expect(await cmdRoute(['--help'], { out: out.push })).toBe(0);
    expect(out.lines.join('\n')).toContain('phm route job');
    expect(await cmdRoute([], { out: () => {} })).toBe(0);
  });
});
