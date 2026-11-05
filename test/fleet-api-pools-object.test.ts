import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { apiPools, cmdFleetApiPools, type ApiPool } from '../src/cli/fleet-api-pools.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'api-pools-')); dirs.push(dir);
  const path = join(dir, 'status.json'); await writeFile(path, JSON.stringify(value));
  return vi.fn(async (_path: string) => readFile(path, 'utf8'));
}

const objectStatus = {
  budget: {
    'claude-api': {
      estimated_cost_per_job: 3,
      ceiling: 10,
      pools: {
        gift: { open: true, spent: 0, balance: 500, hours_left: 200, need_usd_per_hour: 25 },
        monthly: { open: true, spent: 120, balance: 380, hours_left: 48, need_usd_per_hour: 15 },
        legacy: { open: false, spent: 999, balance: 0, hours_left: 9999, need_usd_per_hour: 50 },
      },
    },
  },
};

const idleStatus = {
  budget: {
    'claude-api': {
      estimated_cost_per_job: 2,
      pools: {
        trial: { spent: 0, balance: 100, hours_left: 10, need_usd_per_hour: 5 },
        active: { spent: 50, balance: 200, hours_left: 500, need_usd_per_hour: 10 },
      },
    },
  },
};

const partialStatus = {
  budget: {
    'claude-api': {
      pools: {
        uncapped: { open: true, spent: 10, balance: 90, hours_left: 30, est_job_usd: 1.5 },
      },
    },
  },
};

it('reads an object-keyed fixture and adds name, spent, balance per pool with total need', async () => {
  const reader = await fixture(objectStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetApiPools(['--json'], reader)).toBe(0);
  const report = JSON.parse(output.mock.calls[0]![0]);
  expect(report).toMatchObject({ readOnly: true, schema: 'fleet.api-pools.v1' });
  // Object case shows all pools; legacy has no idle mark but is included
  expect(report.pools).toHaveLength(3);
  const named = report.pools as ApiPool[];
  const gift = named.find((p: ApiPool) => 'name' in p && (p as { name: string }).name === 'gift');
  const monthly = named.find((p: ApiPool) => 'name' in p && (p as { name: string }).name === 'monthly');
  const legacy = named.find((p: ApiPool) => 'name' in p && (p as { name: string }).name === 'legacy');
  expect(gift).toMatchObject({ name: 'gift', spent: 0, balance: 500, hours_left: 200, need_usd_per_hour: 25 });
  expect(monthly).toMatchObject({ name: 'monthly', spent: 120, balance: 380, hours_left: 48, need_usd_per_hour: 15 });
  expect(legacy).toMatchObject({ name: 'legacy', spent: 999, balance: 0, hours_left: 9999, need_usd_per_hour: 50 });
  // gift is idle (spent=0, hours_left=200 < 720), legacy is not (spent=999)
  expect((gift as { idle?: boolean }).idle).toBe(true);
  expect((legacy as { idle?: boolean }).idle).toBeUndefined();
  expect(report.need_usd_per_hour).toBe(90); // 25 + 15 + 50
});

it('marks pools as idle when spent is 0 and hours_left under 720', async () => {
  const reader = await fixture(idleStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools(['--json'], reader);
  const report = JSON.parse(output.mock.calls[0]![0]);
  const pools = report.pools as ApiPool[];
  const trial = pools.find((p: ApiPool) => 'name' in p && (p as { name: string }).name === 'trial');
  const active = pools.find((p: ApiPool) => 'name' in p && (p as { name: string }).name === 'active');
  expect((trial as { idle?: boolean }).idle).toBe(true);
  expect((active as { idle?: boolean }).idle).toBeUndefined();
  expect(report.pools).toHaveLength(2);
});

it('falls back to budget.estimated_cost_per_job when pool has no est_job_usd', async () => {
  const reader = await fixture(partialStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools(['--json'], reader);
  const report = JSON.parse(output.mock.calls[0]![0]);
  const pools = report.pools as ApiPool[];
  const pool = pools[0] as { est_job_usd: number | null };
  expect(pool.est_job_usd).toBe(1.5); // explicit pool-level est_job_usd wins
});

it('falls back to budget.estimated_cost_per_job when pool omits est_job_usd', async () => {
  const noEstStatus = {
    budget: {
      'claude-api': {
        estimated_cost_per_job: 4,
        pools: {
          default_pool: { open: true, spent: 20, balance: 180, hours_left: 60, need_usd_per_hour: 10 },
        },
      },
    },
  };
  const reader = await fixture(noEstStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools(['--json'], reader);
  const report = JSON.parse(output.mock.calls[0]![0]);
  const pools = report.pools as ApiPool[];
  expect((pools[0] as { est_job_usd: number | null }).est_job_usd).toBe(4);
});

it('prints object-keyed pools with name, spent, balance in plain output', async () => {
  const reader = await fixture(objectStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools([], reader);
  const text = output.mock.calls[0]![0] as string;
  expect(text).toContain('Pool "gift"');
  expect(text).toContain('spent $0');
  expect(text).toContain('balance $500');
  expect(text).toContain('(IDLE)'); // gift has spent=0 and hours_left=200 < 720
  expect(text).not.toContain('Pool 1'); // array-style numbering absent
  expect(text).toContain('Total need');
  expect(text).toContain('Pool "monthly"');
  expect(text).toContain('Pool "legacy"');
});

it('falls back to hours_left for idle check when hours_left is null', async () => {
  const noHoursStatus = {
    budget: {
      'claude-api': {
        pools: {
          noHours: { spent: 0, balance: 50 },
        },
      },
    },
  };
  const reader = await fixture(noHoursStatus);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools(['--json'], reader);
  const report = JSON.parse(output.mock.calls[0]![0]);
  const pools = report.pools as ApiPool[];
  const pool = pools[0] as { idle?: boolean; hours_left: number | null };
  // hours_left is null, so hoursLeft = Infinity, not < 720, should NOT be idle
  expect(pool.idle).toBeUndefined();
});

it('handles empty object pools gracefully', async () => {
  const emptyObjStatus = {
    budget: {
      'claude-api': {
        pools: {},
      },
    },
  };
  const result = apiPools(emptyObjStatus);
  expect(result.pools).toHaveLength(0);
  expect(result.need_usd_per_hour).toBe(0);
});

it('preserves array behavior when pools is an array (no regression)', async () => {
  const reader = await fixture(objectStatus);
  // Swap to array pools
  const arrayStatus = JSON.parse(JSON.stringify(objectStatus));
  (arrayStatus.budget['claude-api'].pools as Record<string, unknown>[]) = [
    { open: true, remaining: 100, need_usd_per_hour: 25, hours_left: 200, projected_end_pct: 10 },
  ];
  const dir = await mkdtemp(join(tmpdir(), 'api-pools-')); dirs.push(dir);
  const path = join(dir, 'status.json');
  await writeFile(path, JSON.stringify(arrayStatus));
  const arrReader = vi.fn(async (_path: string) => readFile(path, 'utf8'));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await cmdFleetApiPools(['--json'], arrReader);
  const report = JSON.parse(output.mock.calls[0]![0]);
  // Array-style pool should NOT have 'name'
  const pool = report.pools[0] as Record<string, unknown>;
  expect(pool.name).toBeUndefined();
  expect(pool.remaining).toBe(100);
  expect(pool.need_usd_per_hour).toBe(25);
});
