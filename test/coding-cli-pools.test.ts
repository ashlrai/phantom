import { describe, expect, it } from 'vitest';

import { jobShapeHeuristic } from '../src/core/decide/job-shape.js';
import { resolveAccounts } from '../src/core/providers/coding-cli/accounts.js';
import { loadCatalog } from '../src/core/providers/coding-cli/catalog.js';
import { chooseCodingSeat, planLabelledWork } from '../src/core/providers/coding-cli/policy.js';
import { seedCodingPools } from '../src/core/providers/coding-cli/pools.js';
import { rankSpendPools, UNKNOWN_BALANCE_SOFT_CAP_PER_DAY } from '../src/core/resources/pool-spend.js';

const NOW = Date.parse('2026-10-26T02:00:00.000Z');

describe('coding account pool admission', () => {
  const catalog = loadCatalog();

  it('keeps subscription and local pools spendable after prior daily jobs', () => {
    const accounts = resolveAccounts(catalog, {}, {
      'codex-primary': { usedPercent: 20, resetsAt: '2026-10-25T02:00:00.000Z' },
    });
    const pools = seedCodingPools({
      catalog,
      accounts,
      usedToday: { 'codex:codex-primary': 8, 'ollama:ollama': 8 },
    }).pools;
    const seats = pools.filter((pool) => pool.billing === 'subscription' || pool.billing === 'local');
    expect(seats.length).toBeGreaterThan(0);
    expect(seats.every((pool) => pool.balance === null && pool.expiresAt === null)).toBe(true);
    expect(JSON.parse(JSON.stringify(seats)).every((pool: { softCapPerDay: unknown }) => Number.isFinite(pool.softCapPerDay))).toBe(true);
    const spendable = rankSpendPools(seats, { nowMs: NOW, floor: 'cheap', meteredEnabled: false });
    expect(spendable.map((pool) => pool.id)).toContain('codex:codex-primary');
    expect(spendable.map((pool) => pool.id)).toContain('ollama:ollama');
  });

  it('routes multiple jobs to a subscription after its quota reset', async () => {
    const plan = await planLabelledWork({
      catalog: { ...catalog, concurrency: { ...catalog.concurrency, codex: 3 } },
      repo: '/work/phantom',
      nowMs: NOW,
      issues: [1, 2, 3].map((number) => ({ number, title: 'Refactor the parser', body: '', labels: ['route:any'] })),
      usedToday: { 'cloud-credits': 1, 'codex:codex-primary': 4 },
      readings: { 'codex-primary': { usedPercent: 20, resetsAt: '2026-10-25T02:00:00.000Z' } },
      env: {},
      classify: async () => jobShapeHeuristic('Refactor the parser'),
    });
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.every((step) => step.action === 'run' && step.poolId === 'codex:codex-primary')).toBe(true);
  });

  it('still blocks a cooled subscription and keeps unknown credit and metered balances capped', () => {
    const accounts = resolveAccounts(catalog, {}, {
      'codex-primary': { usedPercent: 5, resetsAt: null, cooledUntilMs: NOW + 60_000 },
    });
    const pools = seedCodingPools({
      catalog,
      accounts,
      usedToday: { 'cloud-credits': 1, 'devin-acu': 1 },
    }).pools;
    const credits = pools.find((pool) => pool.id === 'cloud-credits')!;
    const metered = pools.find((pool) => pool.id === 'devin-acu')!;
    expect(credits.softCapPerDay).toBe(UNKNOWN_BALANCE_SOFT_CAP_PER_DAY);
    expect(metered.softCapPerDay).toBe(UNKNOWN_BALANCE_SOFT_CAP_PER_DAY);
    const open = rankSpendPools(pools, { nowMs: NOW, floor: 'frontier', meteredEnabled: true });
    expect(open.map((pool) => pool.id)).not.toContain('codex:codex-primary');
    expect(open.map((pool) => pool.id)).not.toContain('cloud-credits');
    expect(open.map((pool) => pool.id)).not.toContain('devin-acu');
  });

  it('retains an explicitly observed credit expiry independently of a seat reset', () => {
    const pools = seedCodingPools({
      catalog,
      accounts: resolveAccounts(catalog, {}),
      balances: { 'cloud-credits': { balance: 5, expiresAt: '2026-10-25T00:00:00.000Z' } },
    }).pools;
    const open = rankSpendPools(pools, { nowMs: NOW, floor: 'frontier', meteredEnabled: false });
    expect(open.map((pool) => pool.id)).not.toContain('cloud-credits');
  });

  it.each([100, 80, null])('refuses a sole subscription without admitted headroom (%s percent used)', (usedPercent) => {
    const accounts = resolveAccounts(catalog, {}, {
      'codex-primary': { usedPercent, resetsAt: '2026-10-27T02:00:00.000Z' },
    }).filter((account) => account.id === 'codex-primary');
    expect(chooseCodingSeat({
      catalog,
      accounts,
      shape: { ...jobShapeHeuristic('Refactor parser'), complexity: 'high' },
      nowMs: NOW,
      usedToday: { 'cloud-credits': 1 },
    })).toBeNull();
  });

  it('tries the next spend class when every subscription is exhausted', () => {
    const accounts = resolveAccounts(catalog, {}, {
      'codex-primary': { usedPercent: 100, resetsAt: '2026-10-27T02:00:00.000Z' },
    }).filter((account) => account.id === 'codex-primary' || account.backend === 'ollama');
    expect(chooseCodingSeat({
      catalog,
      accounts,
      shape: { ...jobShapeHeuristic('Fix typo'), complexity: 'low', risk: 'low' },
      nowMs: NOW,
      usedToday: { 'cloud-credits': 1 },
    })).toMatchObject({ backend: 'ollama', poolId: 'ollama:ollama' });
  });

  it('requires an explicit metered opt-in before a rejected subscription can fall back to Devin', () => {
    const input = {
      catalog,
      shape: { ...jobShapeHeuristic('Refactor parser'), complexity: 'high' as const },
      nowMs: NOW,
      usedToday: { 'cloud-credits': 1 },
      env: { DEVIN_API_KEY: 'cog_fixture_not_a_live_key' },
    };
    expect(chooseCodingSeat(input)).toBeNull();
    expect(chooseCodingSeat({ ...input, meteredEnabled: true })).toMatchObject({ backend: 'devin', poolId: 'devin-acu' });
  });

  it('uses the second account when the preferred account reaches its concurrency cap', async () => {
    const plan = await planLabelledWork({
      catalog,
      repo: '/work/phantom',
      nowMs: NOW,
      issues: [1, 2, 3].map((number) => ({ number, title: 'Refactor the parser', body: '', labels: ['route:any'] })),
      usedToday: { 'cloud-credits': 1 },
      readings: {
        'codex-primary': { usedPercent: 10, resetsAt: '2026-10-27T02:00:00.000Z' },
        'codex-secondary': { usedPercent: 20, resetsAt: '2026-10-27T02:00:00.000Z' },
      },
      env: { CODEX_HOME_ALT: '/fixture/codex-secondary' },
      classify: async () => ({ ...jobShapeHeuristic('Refactor the parser'), complexity: 'medium' as const }),
    });
    expect(plan.steps.map((step) => [step.action, step.accountId])).toEqual([
      ['run', 'codex-primary'], ['run', 'codex-secondary'], ['skip', null],
    ]);
  });

  it('spreads equal headroom using the worker account counts rather than pool-id keys', async () => {
    const plan = await planLabelledWork({
      catalog: { ...catalog, concurrency: { ...catalog.concurrency, codex: 2 } },
      repo: '/work/phantom',
      nowMs: NOW,
      issues: [1, 2, 3].map((number) => ({ number, title: 'Refactor the parser', body: '', labels: ['route:any'] })),
      usedToday: { 'cloud-credits': 1 },
      readings: {
        'codex-primary': { usedPercent: 20, resetsAt: '2026-10-27T02:00:00.000Z' },
        'codex-secondary': { usedPercent: 20, resetsAt: '2026-10-27T02:00:00.000Z' },
      },
      env: { CODEX_HOME_ALT: '/fixture/codex-secondary' },
      classify: async () => jobShapeHeuristic('Refactor the parser'),
    });
    expect(plan.steps.map((step) => [step.action, step.accountId])).toEqual([
      ['run', 'codex-primary'], ['run', 'codex-secondary'], ['run', 'codex-primary'],
    ]);
  });

  it('counts the cloud worker slot when a known balance permits multiple daily jobs', async () => {
    const plan = await planLabelledWork({
      catalog,
      repo: '/work/phantom',
      nowMs: NOW,
      issues: [1, 2].map((number) => ({ number, title: 'Refactor the parser', body: '', labels: ['route:any'] })),
      balances: { 'cloud-credits': { balance: 10 } },
      readings: { 'codex-primary': { usedPercent: 20, resetsAt: '2026-10-27T02:00:00.000Z' } },
      env: {},
      classify: async () => jobShapeHeuristic('Refactor the parser'),
    });
    expect(plan.steps.map((step) => [step.action, step.backend])).toEqual([
      ['run', 'cloud'], ['run', 'codex'],
    ]);
  });
});
