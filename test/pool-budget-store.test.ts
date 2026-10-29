import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addBudgetReadings, readPoolBudgets } from '../src/core/fleet/pool-budget-store.js';
import { cmdBudget } from '../src/cli/budget.js';
import type { BudgetReading } from '../src/core/fleet/pool-budget.js';
const state = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => state.home }));
let directory: string;
const sample: BudgetReading = { pool: 'codex-cmp', bucket: 'credits', remaining: 42,
  timestamp: '2026-10-25T10:00:00.000Z', resetAt: null, source: 'manual' };
beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'pool-budget-'));
  directory = join(state.home, '.ashlr', 'fleet', 'budgets');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(state.home, { recursive: true, force: true }); });
describe('immutable budget storage and CLI', () => {
  it('missing store reports unknown without writing directories', async () => {
    expect((await readPoolBudgets(directory)).pools['codex-cmp'].remainingCredits).toBeNull();
    expect(await readdir(state.home)).toEqual([]);
  });
  it('preserves concurrent appends and strips unknown fields', async () => {
    await Promise.all([
      addBudgetReadings([{ ...sample, privateText: 'discard-me' } as BudgetReading], directory),
      addBudgetReadings([{ ...sample, pool: 'devin', bucket: 'acus', remaining: 12 }], directory),
    ]);
    const snapshot = await readPoolBudgets(directory);
    expect(snapshot.pools['codex-cmp'].remainingCredits).toBe(42);
    expect(snapshot.pools.devin.buckets.acus?.remaining).toBe(12);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const file of files) expect(await readFile(join(directory, file), 'utf8')).not.toContain('discard-me');
  });
  it('corrupt records degrade the complete snapshot rather than inventing balances', async () => {
    await addBudgetReadings([sample], directory);
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), 'invalid json');
    expect(await readPoolBudgets(directory)).toMatchObject({ sourceState: 'unavailable', pools: { 'codex-cmp': { remainingCredits: null } } });
  });
  it('validates the entire batch before writing and refuses future observations', async () => {
    await expect(addBudgetReadings([sample, { ...sample, remaining: -1 }], directory)).rejects.toThrow();
    await expect(addBudgetReadings([{ ...sample, timestamp: '2099-01-01T00:00:00Z' }], directory)).rejects.toThrow();
    expect(await readdir(state.home)).toEqual([]);
  });
  it('CLI add/show emits one JSON object and preserves the manual source', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdBudget(['add', 'codex-cmp', '--bucket', 'credits', '--remaining', '42', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string).budgets.pools['codex-cmp'].buckets.credits).toMatchObject({ remaining: 42, source: 'manual' });
    log.mockClear();
    expect(await cmdBudget(['show', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('CLI plan emits the pacing decisions without touching the ledger', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdBudget(['add', 'codex-cmp', '--bucket', 'weeklyPct', '--remaining', '60', '--reset-at', '2099-01-01T00:00:00Z', '--json'])).toBe(0);
    log.mockClear();
    expect(await cmdBudget(['plan', '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const plan = JSON.parse(log.mock.calls[0]![0] as string).plan;
    expect(plan.schema).toBe('fleet.budget-plan.v1');
    expect(plan.decisions['codex-cmp']).toMatchObject({ lane: 'weekly', weeklyOpen: true, creditsOpen: false, concurrency: 'raise' });
    expect(plan.decisions['codex-cmp'].reasons.length).toBeGreaterThan(0);
    expect(plan.decisions['grok-ultra'].maxConcurrency).toBe(1);
    expect(plan.decisions.claude).toMatchObject({ lane: 'held', concurrency: 'pause' });
    expect(await readdir(directory)).toHaveLength(1);
  });
  it('CLI imports only parsed log observations', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const input = join(state.home, 'provider.log');
    await writeFile(input, 'acus remaining: 12.5\nprivate-value=discard-me\n');
    expect(await cmdBudget(['add', 'devin', '--source', 'log', '--input', input, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string).budgets.pools.devin.buckets.acus).toMatchObject({ remaining: 12.5, source: 'log' });
    const [file] = await readdir(directory);
    expect(await readFile(join(directory, file!), 'utf8')).not.toContain('discard-me');
  });
  it.each([
    ['add', 'unknown', '--remaining', '1'],
    ['add', 'codex-cmp', '--bucket', 'weeklyPct', '--remaining', '101'],
    ['add', 'codex-cmp', '--bucket', 'credits', '--remaining', ''],
    ['add', 'codex-cmp', '--source', 'cli', '--input', 'missing-private-file'],
    ['show', '--remaining', '1'], ['add', 'claude', '--bucket', 'credits', '--remaining', '2'],
    ['show', '--wat'], ['plan', '--remaining', '1'], ['plan', 'extra'],
  ])('rejects invalid command %j without exposing input', async (...args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdBudget([...args, '--json'])).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(error.mock.calls[0]![0] as string)).toHaveProperty('error');
    expect(JSON.stringify(error.mock.calls)).not.toContain('missing-private-file');
    expect(await readdir(state.home)).toEqual([]);
  });
  it('help does not mutate even when add flags are present', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdBudget(['add', 'codex-cmp', '--help'])).toBe(0);
    expect(await readdir(state.home)).toEqual([]);
  });
});
