import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { apiPools, cmdFleetApiPools } from '../src/cli/fleet-api-pools.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'api-pools-')); dirs.push(dir);
  const path = join(dir, 'status.json'); await writeFile(path, JSON.stringify(value));
  return vi.fn(async (_path: string) => readFile(path, 'utf8'));
}
const status = { budget: { 'claude-api': { estimated_cost_per_job: 2, ceiling: 8, pools: [
  { open: true, remaining: 100, need_usd_per_hour: 17, hours_left: 5, projected_end_pct: 12, private: 'omit' },
  { status: 'open', remaining: 80, need_usd_per_hour: 8, hours_left: 10, projected_end_pct: 0 },
  { open: false, remaining: 200, need_usd_per_hour: 999 },
] } } };
it('reads a fixture through the injected reader, sums open pools and rounds up with four jobs per slot-hour', async () => {
  const reader = await fixture(status), output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetApiPools(['--json'], reader)).toBe(0);
  expect(reader.mock.calls[0]![0]).toMatch(/\.ashlr-runs\/queue\/status\.json$/);
  const report = JSON.parse(output.mock.calls[0]![0]);
  expect(report).toMatchObject({ readOnly: true, need_usd_per_hour: 25, jobs_per_slot_hour: 4, slot_target: 4 });
  expect(report.pools).toHaveLength(2);
  expect(report.pools[0]).toEqual({ remaining: 100, need_usd_per_hour: 17, hours_left: 5, projected_end_pct: 12 });
  expect(await cmdFleetApiPools(['--cost-per-job', '1', '--jobs-per-slot-hour', '2', '--ceiling', '3'], reader)).toBe(0);
  expect(output.mock.calls.at(-1)![0]).toContain('slot target: 3');
});
it('handles empty and incomplete observations without inventing capacity', async () => {
  expect(apiPools({ budget: { 'claude-api': { pools: [] } } }).slot_target).toBe(0);
  expect(apiPools(status, { costPerJob: 0 }).slot_target).toBeNull();
  expect(apiPools({ budget: { 'claude-api': { pools: [{ open: true }] } } })).toMatchObject({ need_usd_per_hour: null, slot_target: null });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetApiPools(['--json'], await fixture({ budget: { 'claude-api': { pools: [{ open: true, need_usd_per_hour: 5 }] } } }))).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0]).slot_target).toBeNull();
});
it('rejects unreadable, malformed and absent pool data with a fixed error', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const reader of [async () => { throw new Error('private'); }, async () => '{', await fixture({})]) {
    expect(await cmdFleetApiPools(['--json'], reader)).toBe(1);
  }
  expect(error.mock.calls.every(call => call[0] === 'error: unable to read API pool observations')).toBe(true);
});
it('validates flags before reading and supports help', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {});
  const reader = vi.fn(async () => '{}');
  for (const args of [['--bad'], ['--json', '--json'], ['--ceiling', '1.5'], ['--cost-per-job', '0'], ['--jobs-per-slot-hour', '-1'], ['--ceiling']]) {
    expect(await cmdFleetApiPools(args, reader)).toBe(2);
  }
  expect(await cmdFleetApiPools(['--help'], reader)).toBe(0);
  expect(reader).not.toHaveBeenCalled();
});
