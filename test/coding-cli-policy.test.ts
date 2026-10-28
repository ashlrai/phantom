/**
 * Coding-CLI policy: job shape, pool spend order, account failover, Devin gate.
 * Fake clocks and fixture CLI text. No network.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { classifyJob, jobShapeHeuristic, type JobShape } from '../src/core/decide/job-shape.js';
import type { Decision } from '../src/core/decide/types.js';
import { DEFAULT_CLOUD_BUDGET } from '../src/core/cloud/types.js';
import { DEFAULT_DEVIN_BUDGET } from '../src/core/devin/types.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import { routeSeat } from '../src/core/routing/router.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { roleAllowed } from '../src/core/routing/backend-roles.js';
import { rankSpendPools, UNKNOWN_BALANCE_SOFT_CAP_PER_DAY, type SpendPool } from '../src/core/resources/pool-spend.js';
import { accountEnv, bestAccount, failoverAccount, resolveAccounts } from '../src/core/providers/coding-cli/accounts.js';
import { loadCatalog } from '../src/core/providers/coding-cli/catalog.js';
import { DOCUMENTED_DEVIN_ORG_ID, devinCredentials } from '../src/core/providers/coding-cli/devin-gate.js';
import { parseCliCooldown } from '../src/core/providers/coding-cli/limits.js';
import { chooseCodingSeat, planLabelledWork } from '../src/core/providers/coding-cli/policy.js';
import { formatPoolFigures, seedCodingPools } from '../src/core/providers/coding-cli/pools.js';
import { executeStep } from '../src/core/providers/coding-cli/worker-plan.js';
import { shouldEscalate } from '../src/core/run/router.js';
import type { CascadeDecision } from '../src/core/run/router.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');
const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/coding-cli/cli-output.txt'), 'utf8');
const line = (prefix: string): string => {
  const found = FIXTURE.split('\n').find((row) => row.startsWith(prefix));
  if (!found) throw new Error(`missing fixture ${prefix}`);
  return found.slice(prefix.length).trim();
};

function pool(partial: Partial<SpendPool> & Pick<SpendPool, 'id' | 'billing'>): SpendPool {
  return {
    balance: null,
    expiresAt: null,
    usedToday: 0,
    softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
    tier: 'frontier',
    headroomPercent: null,
    ...partial,
  };
}

function decision(value: JobShape, path: 'jev' | 'fallback'): Decision<JobShape> {
  return {
    kind: 'job-shape',
    value,
    path,
    confidence: 1,
    threshold: 0.75,
    cached: false,
    durationMs: 0,
    ...(path === 'fallback' ? { reason: 'no-key' as const } : {}),
  };
}

describe('pool spend order', () => {
  const rank = { nowMs: NOW, floor: 'frontier' as const, meteredEnabled: true };

  it('spends a known expiry, then an unknown credit, then a subscription, then local, then metered', () => {
    const order = rankSpendPools([
      pool({ id: 'meter', billing: 'metered', tier: 'frontier', meteredOptIn: true, headroomPercent: 99 }),
      pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 }),
      pool({ id: 'sub', billing: 'subscription', headroomPercent: 90 }),
      pool({ id: 'unknown-credit', billing: 'credit', headroomPercent: 10 }),
      pool({ id: 'soon', billing: 'credit', expiresAt: '2026-10-26T06:00:00.000Z', balance: 5, headroomPercent: 5 }),
      pool({ id: 'later', billing: 'credit', expiresAt: '2026-11-01T00:00:00.000Z', balance: 5, headroomPercent: 80 }),
    ], rank).map((row) => row.id);
    expect(order).toEqual(['soon', 'later', 'unknown-credit', 'sub', 'meter']);
  });

  it('keeps an unknown balance spendable until the soft cap, and records that figures are missing', () => {
    const unknown = pool({ id: 'cloud-credits', billing: 'credit' });
    expect(rankSpendPools([unknown], rank).map((row) => row.id)).toEqual(['cloud-credits']);
    expect(rankSpendPools([{ ...unknown, usedToday: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY }], rank)).toEqual([]);
    const seeded = seedCodingPools({
      catalog: loadCatalog(),
      accounts: resolveAccounts(loadCatalog(), {}),
    });
    const text = formatPoolFigures(seeded.figures);
    expect(text).toContain('pools needing figures:');
    expect(text).toContain('cloud-credits');
    expect(text).toContain('balance unknown');
    expect(text).toContain('expiry unknown');
    expect(text).toContain(String(DEFAULT_CLOUD_BUDGET.creditsTotalUsd));
    expect(text).toContain(String(DEFAULT_DEVIN_BUDGET.acuBudgetTotal));
  });

  it('drops local models under a frontier floor and holds metered work until it is enabled', () => {
    const rows = [
      pool({ id: 'local', billing: 'local', tier: 'cheap', headroomPercent: 100 }),
      pool({ id: 'grok', billing: 'metered', tier: 'workhorse', headroomPercent: 100 }),
      pool({ id: 'codex', billing: 'subscription', headroomPercent: 20 }),
    ];
    expect(rankSpendPools(rows, { nowMs: NOW, floor: 'frontier', meteredEnabled: false }).map((row) => row.id)).toEqual(['codex']);
    expect(rankSpendPools(rows, { nowMs: NOW, floor: 'cheap', meteredEnabled: true }).map((row) => row.id)).toEqual(['codex', 'local', 'grok']);
    expect(roleAllowed('subscription', 'merge')).toBe(false);
    expect(roleAllowed('local', 'credential')).toBe(false);
  });
});

describe('accounts and route:any', () => {
  const catalog = loadCatalog();

  it('prefers the Codex account with more headroom and fails over after a fixture rate limit', async () => {
    const accounts = resolveAccounts(catalog, { CODEX_HOME_ALT: '/tmp/codex-alt' }, {
      'codex-primary': { usedPercent: 80, resetsAt: '2026-10-27T00:00:00.000Z' },
      'codex-secondary': { usedPercent: 10, resetsAt: '2026-10-28T00:00:00.000Z' },
    });
    expect(bestAccount(accounts, 'codex', NOW)?.id).toBe('codex-secondary');
    expect(failoverAccount(accounts, 'codex', 'codex-secondary', NOW)?.id).toBe('codex-primary');
    expect(accountEnv({ PATH: '/usr/bin', GH_TOKEN: 'ghp_secret' }, accounts.find((row) => row.id === 'codex-secondary') ?? null)).toMatchObject({
      CODEX_HOME: '/tmp/codex-alt',
    });

    const cooled = parseCliCooldown('codex', line('codex rate limit:'), NOW);
    expect(cooled?.untilMs).toBe(Date.parse('2026-10-26T06:00:00.000Z'));
    const step = {
      number: 4,
      title: 'Spread',
      action: 'run' as const,
      reason: 'pinned',
      route: 'route:codex' as const,
      backend: 'codex',
      billing: 'subscription' as const,
      model: null,
      role: 'produce' as const,
      accountId: 'codex-secondary',
      poolId: 'codex:codex-secondary',
      worktree: '/tmp/issue-4',
      pullRequest: 'draft' as const,
    };
    const homes: Array<string | undefined> = [];
    const result = await executeStep(step, { number: 4, title: 'Spread', body: '', labels: ['route:codex'] }, catalog, {
      run: async (bin, _args, env) => {
        if (bin === 'git' || bin === 'gh') return { code: 0, stdout: '', stderr: '' };
        homes.push(env['CODEX_HOME']);
        if (homes.length === 1) return { code: 1, stdout: '', stderr: line('codex rate limit:') };
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    }, { PATH: '/usr/bin', GH_TOKEN: 'nope' }, { get: () => null }, { accounts, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(homes).toEqual(['/tmp/codex-alt', undefined]);
    expect(JSON.stringify(result)).not.toContain('nope');
  });

  it('sends route:any to the unknown cloud credit pool, then to a subscription once that cap is spent', async () => {
    const first = await planLabelledWork({
      catalog,
      issues: [{ number: 1, title: 'Refactor the parser', body: 'move the helper', labels: ['route:any'] }],
      repo: '/work/phantom',
      nowMs: NOW,
      classify: async () => jobShapeHeuristic('Refactor the parser'),
    });
    expect(first.steps[0]).toMatchObject({ action: 'run', backend: 'cloud', poolId: 'cloud-credits', role: 'produce' });
    const second = await planLabelledWork({
      catalog,
      issues: [{ number: 2, title: 'Refactor the parser', body: 'move the helper', labels: ['route:any'] }],
      repo: '/work/phantom',
      nowMs: NOW,
      usedToday: { 'cloud-credits': 1 },
      readings: { 'codex-primary': { usedPercent: 15, resetsAt: '2026-10-30T00:00:00.000Z' } },
      env: {},
      classify: async () => jobShapeHeuristic('Refactor the parser'),
    });
    expect(second.steps[0]?.backend).toBe('codex');
    expect(second.steps[0]?.poolId).toBe('codex:codex-primary');
    expect(second.steps[0]?.role).toBe('produce');
  });
});

describe('job shape and escalation', () => {
  it('uses the heuristic when Jev falls back, and will not accept a lower risk', async () => {
    const text = 'Rotate the deploy secret in the auth path';
    const fallback = await classifyJob(text, {
      ask: async () => decision(jobShapeHeuristic(''), 'fallback'),
    });
    expect(fallback).toMatchObject({ source: 'heuristic', risk: 'high' });
    const lowered = await classifyJob(text, {
      ask: async () => decision({ ...jobShapeHeuristic(text), risk: 'low', source: 'jev' }, 'jev'),
    });
    expect(lowered.risk).toBe('high');
    expect(lowered.source).toBe('jev');
    expect(lowered.contextTokens).toBeGreaterThanOrEqual(text.length);
  });

  it('escalates a lint failure once and stops at the cap', () => {
    const local = { tierLabel: 'local', engine: 'builtin', attempt: 1 } as CascadeDecision;
    const signal = shouldEscalate({ hasDiff: true, testsPassed: true, applySucceeded: true, lintPassed: false }, local);
    expect(signal).toMatchObject({ escalate: true, toTier: 'mid' });
    const capped = shouldEscalate(
      { hasDiff: true, testsPassed: true, applySucceeded: true, lintPassed: false },
      { ...local, attempt: 3 },
    );
    expect(capped.escalate).toBe(false);
  });
});

describe('seat router options', () => {
  function seat(id: string, used: number, extra: Partial<SeatCapacity> = {}): SeatCapacity {
    return {
      seatId: id,
      engine: 'codex',
      label: id,
      free: false,
      windows: [{ id: 'codex_codex_secondary', usedPercent: used, resetsAt: '2026-10-30T00:00:00.000Z', resetDescription: null, limitReached: false }],
      signedOut: false,
      reachable: null,
      contextWindow: 200_000,
      observedAt: new Date(NOW).toISOString(),
      spentTodayUsd: null,
      costBasis: 'subscription',
      billingClass: 'subscription',
      ...extra,
    };
  }

  it('breaks an equal headroom tie toward the sooner reset only when spend-down is on', () => {
    const seats = [seat('later', 20), seat('sooner', 20)];
    const scheduling = {
      later: view('later', '2026-10-28T00:00:00.000Z'),
      sooner: view('sooner', '2026-10-26T06:00:00.000Z'),
    };
    const base = { task: 'code' as const, difficulty: 'medium' as const, autonomous: true };
    const policy = defaultBudgetPolicy();
    expect(routeSeat(base, seats, policy, { nowMs: NOW }).seatId).toBe('later');
    expect(routeSeat(base, seats, policy, { nowMs: NOW, spendDown: true, scheduling }).seatId).toBe('sooner');
    expect(routeSeat(base, [seat('busy', 50), seat('open', 10)], policy, {
      nowMs: NOW,
      spendDown: true,
      scheduling: { busy: scheduling.sooner, open: scheduling.later },
    }).seatId).toBe('open');
  });

  it('spreads in-flight ties and keeps metered seats out until they opt in', () => {
    const policy = defaultBudgetPolicy();
    const base = { task: 'code' as const, difficulty: 'medium' as const, autonomous: true };
    const seats = [seat('a', 20), seat('b', 20)];
    expect(routeSeat(base, seats, policy, { nowMs: NOW, inFlight: { a: 2, b: 0 } }).seatId).toBe('b');
    const metered = seat('api', 20, { billingClass: 'metered', costBasis: 'per-token' });
    const held = routeSeat(base, [metered, seat('sub', 20)], policy, { nowMs: NOW, enforceMeteredOptIn: true });
    expect(held.seatId).toBe('sub');
    expect(held.exclusions.some((row) => row.seatId === 'api')).toBe(true);
    const opted = routeSeat(base, [metered, seat('sub', 20)], policy, { nowMs: NOW, enforceMeteredOptIn: true });
    expect(routeSeat(base, [{ ...metered, meteredOptIn: true }, seat('sub', 20)], policy, { nowMs: NOW, enforceMeteredOptIn: true }).candidates[0]).toBe('sub');
    expect(opted.seatId).toBe('sub');
  });
});

describe('Devin gate', () => {
  it('enables the adapter only when the env key and an org id are both present', async () => {
    expect(devinCredentials({})).toBeNull();
    expect(devinCredentials({ DEVIN_ORG_ID: DOCUMENTED_DEVIN_ORG_ID })).toBeNull();
    expect(devinCredentials({ DEVIN_API_KEY: 'not-a-cog-key' })).toBeNull();
    const creds = devinCredentials({ DEVIN_API_KEY: 'cog_testkeyvalue' });
    expect(creds).toEqual({ apiKey: 'cog_testkeyvalue', orgId: DOCUMENTED_DEVIN_ORG_ID });
    const catalog = loadCatalog();
    expect(catalog.backends['devin']?.orgId).toBe(DOCUMENTED_DEVIN_ORG_ID);
    let seenUrl = '';
    let seenAuth = '';
    const result = await executeStep({
      number: 8,
      title: 'Devin',
      action: 'run',
      reason: 'pinned',
      route: 'route:any',
      backend: 'devin',
      billing: 'metered',
      model: null,
      role: 'produce',
      accountId: null,
      poolId: 'devin-acu',
      worktree: '/tmp/issue-8',
      pullRequest: 'draft',
    }, { number: 8, title: 'Devin', body: 'draft a fix', labels: [] }, catalog, {
      run: async () => { throw new Error('runner must not be called'); },
    }, { DEVIN_API_KEY: 'cog_testkeyvalue' }, { get: () => 'cog_from_lookup_not_env' }, {
      devinFetch: async (url, init) => {
        seenUrl = url;
        seenAuth = init.headers['Authorization'] ?? '';
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            session_id: 'devin-abc',
            url: 'https://app.devin.ai/sessions/abc',
            status: 'running',
          }),
        };
      },
    });
    expect(seenUrl).toBe(`https://api.devin.ai/v3/organizations/${DOCUMENTED_DEVIN_ORG_ID}/sessions`);
    expect(seenAuth).toBe('Bearer cog_testkeyvalue');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('devin-abc');
    expect(result.detail).not.toContain('cog_testkeyvalue');
    expect(result.commands.join('\n')).not.toContain('cog_testkeyvalue');
    expect(JSON.stringify(result)).not.toContain('cog_from_lookup_not_env');
    const choice = chooseCodingSeat({
      catalog,
      shape: { ...jobShapeHeuristic('a hard migration'), complexity: 'high', risk: 'high' },
      nowMs: NOW,
      env: { DEVIN_API_KEY: 'cog_testkeyvalue' },
      usedToday: { 'cloud-credits': 1 },
    });
    expect(choice?.backend).not.toBe('devin');
  });
});

function view(seatId: string, at: string) {
  return {
    seatId,
    observedAt: new Date(NOW).toISOString(),
    admission: 'eligible' as const,
    headroomPercent: 40,
    reset: {
      kind: 'weekly-deadline' as const,
      at,
      description: null,
      source: 'codex-native-rate-limits',
      plan: 'plus' as const,
      windowDurationMins: 10080 as const,
      startsAt: null,
    },
    opportunity: { kind: 'before-reset' as const, reason: 'window closes' },
    forecast: {
      taskId: 't',
      durationMs: { p25: 60_000, p50: 90_000, p75: 120_000, samples: 4 },
      tokens: null,
      cohort: { engine: 'codex', model: null, seatId, taskKind: 'code' },
      fit: 'likely-before-reset' as const,
      limitations: [],
    },
  };
}
