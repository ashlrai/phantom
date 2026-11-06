/** Inert event fixtures only. No provider calls, native profiles or credentials. */
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USAGE_POOLS, writeUsageSignal, type UsagePool } from '../src/core/fabric/usage-signal-writer.js';

const START = '2026-10-26T12:00:00.000Z';
const RESET = '2026-11-02T12:00:00.000Z';
const WINDOW = 30 * 60 * 1_000;
const EVENTS = ['dispatch-start', 'pr-merge', '429', 'limit-message', 'manual-reading'] as const;
type Event = typeof EVENTS[number];
type Entry = { pool: UsagePool; pctUsed: number | null; resetAt: string | null; source: string; fetchedAt: string;
  writtenAt: string; event: Event; burnRatePctPerHour: number | null; projected100At: string | null; cutActive: boolean };
let directory: string;
let clock: number;
const now = () => new Date(clock);
const sample = (pool: UsagePool, pctUsed: number | null = 20, resetAt: string | null = RESET) =>
  ({ pool, pctUsed, resetAt, source: `${pool}-reader`, fetchedAt: now().toISOString() });
const lines = (): Entry[] => readFileSync(join(directory, 'usage-readings.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const fleet = (): { readings: Partial<Record<UsagePool, Entry>>; usageSignals: Record<string, unknown>; [key: string]: unknown } =>
  JSON.parse(readFileSync(join(directory, 'fleet.json'), 'utf8'));
const run = (pool: UsagePool = 'codex-cmp', pctUsed: number | null = 20, resetAt: string | null = RESET, event: Event = 'manual-reading') =>
  writeUsageSignal({ directory, event, pools: [pool], readers: { [pool]: async () => sample(pool, pctUsed, resetAt) }, now });

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-usage-signal-')));
  chmodSync(directory, 0o700);
  clock = Date.parse(START);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe('event-driven usage signals', () => {
  it('covers exactly the five operational pools', () => {
    expect(USAGE_POOLS).toEqual(['grok-ultra', 'codex-cmp', 'codex-personal', 'claude-max', 'terra']);
  });

  it.each(EVENTS)('%s reads and writes each pool once per rolling debounce window', async event => {
    const readers = Object.fromEntries(USAGE_POOLS.map(pool => [pool, vi.fn(async () => sample(pool))]));
    const options = { directory, event, readers, now };
    const first = await writeUsageSignal(options);
    expect(first.written).toEqual(USAGE_POOLS);
    expect(first.debounced).toEqual([]);
    expect(lines()).toHaveLength(USAGE_POOLS.length);
    clock += WINDOW - 1;
    const suppressed = await writeUsageSignal(options);
    expect(suppressed.written).toEqual([]);
    expect(suppressed.debounced).toEqual(USAGE_POOLS);
    for (const reader of Object.values(readers)) expect(reader).toHaveBeenCalledTimes(1);
    clock += 1;
    expect((await writeUsageSignal(options)).written).toEqual(USAGE_POOLS);
    expect(lines()).toHaveLength(USAGE_POOLS.length * 2);
    for (const reader of Object.values(readers)) expect(reader).toHaveBeenCalledTimes(2);
  });

  it('uses persisted pool timestamps across independent calls and events', async () => {
    await run('codex-cmp', 10, RESET, 'dispatch-start');
    clock += 10 * 60 * 1_000;
    await run('codex-personal', 40, RESET, 'pr-merge');
    clock += 20 * 60 * 1_000;
    expect((await run('codex-cmp', 15, RESET, '429')).written).toEqual(['codex-cmp']);
    expect((await run('codex-personal', 45, RESET, 'limit-message')).debounced).toEqual(['codex-personal']);
    expect(lines().map(row => row.pool)).toEqual(['codex-cmp', 'codex-personal', 'codex-cmp']);
  });

  it('coalesces concurrent events before duplicate reader execution or publication', async () => {
    const reader = vi.fn(async () => { await Promise.resolve(); return sample('grok-ultra', 30); });
    const results = await Promise.all(EVENTS.map(event => writeUsageSignal({ directory, event,
      pools: ['grok-ultra'], readers: { 'grok-ultra': reader }, now })));
    expect(reader).toHaveBeenCalledTimes(1);
    expect(results.flatMap(result => result.written)).toEqual(['grok-ultra']);
    expect(results.flatMap(result => result.debounced)).toHaveLength(EVENTS.length - 1);
    expect(lines()).toHaveLength(1);
  });

  it('debounces from the completed reading when a reader takes time', async () => {
    const reader = vi.fn(async () => { clock += 15_000; return sample('terra'); });
    await writeUsageSignal({ directory, event: 'dispatch-start', pools: ['terra'], readers: { terra: reader }, now });
    const writtenAt = clock;
    expect(lines()[0]?.writtenAt).toBe(new Date(writtenAt).toISOString());
    clock = Date.parse(START) + WINDOW;
    const suppressed = await writeUsageSignal({ directory, event: 'pr-merge', pools: ['terra'], readers: { terra: reader }, now });
    expect(suppressed.debounced).toEqual(['terra']);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(1);
    clock = writtenAt + WINDOW;
    expect((await writeUsageSignal({ directory, event: 'manual-reading', pools: ['terra'], readers: { terra: reader }, now })).written).toEqual(['terra']);
  });

  it('creates no timer or provider work during twelve idle hours', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(async () => sample('terra'));
    await writeUsageSignal({ directory, event: 'dispatch-start', pools: ['terra'], readers: { terra: reader }, now });
    expect(vi.getTimerCount()).toBe(0);
    clock += 12 * 60 * 60 * 1_000;
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(lines()).toHaveLength(1);
  });

  it('preserves unrelated fleet fields while publishing the exact journal reading', async () => {
    writeFileSync(join(directory, 'fleet.json'), JSON.stringify({ revision: 7, pools: { local: { enabled: true } }, readings: {} }), { mode: 0o600 });
    await run('claude-max', 42);
    const state = fleet();
    expect(state.revision).toBe(7);
    expect(state.pools).toEqual({ local: { enabled: true } });
    expect(state.readings['claude-max']).toEqual(lines()[0]);
    expect(lines()[0]).toMatchObject({ pool: 'claude-max', pctUsed: 42, writtenAt: START, event: 'manual-reading',
      burnRatePctPerHour: null, projected100At: null, cutActive: false });
  });

  it('calculates burn from same-window readings and projects full usage', async () => {
    await run('codex-cmp', 20);
    clock += WINDOW;
    await run('codex-cmp', 30);
    expect(lines()[1]).toMatchObject({ burnRatePctPerHour: 20, projected100At: '2026-10-26T16:00:00.000Z' });
  });

  it.each(['different-reset', 'counter-reset', 'missing-reset', 'unknown'] as const)('does not invent burn across %s evidence', async kind => {
    await run('terra', 50);
    clock += WINDOW;
    await run('terra', kind === 'unknown' ? null : kind === 'counter-reset' ? 5 : 60,
      kind === 'different-reset' ? '2026-11-09T12:00:00.000Z' : kind === 'missing-reset' ? null : RESET);
    expect(lines()[1]).toMatchObject({ burnRatePctPerHour: null, projected100At: null });
  });

  it('does not project exhaustion when usage is unchanged', async () => {
    await run('claude-max', 25);
    clock += WINDOW;
    await run('claude-max', 25);
    expect(lines()[1]?.projected100At).toBeNull();
    expect(lines()[1]?.burnRatePctPerHour).toBe(0);
  });

  it('emits the Grok 80 percent cut once while usage stays above the threshold', async () => {
    expect((await run('grok-ultra', 79)).signals).toEqual([]);
    clock += WINDOW;
    const crossed = await run('grok-ultra', 80);
    expect(crossed.signals).toEqual([{ pool: 'grok-ultra', kind: 'cut', pctUsed: 80, fetchedAt: now().toISOString() }]);
    expect(fleet().usageSignals['grok-ultra']).toEqual(crossed.signals[0]);
    expect(lines().at(-1)?.cutActive).toBe(true);
    clock += WINDOW;
    expect((await run('grok-ultra', 90)).signals).toEqual([]);
  });

  it('rearms the Grok cut after numeric usage falls below the threshold', async () => {
    expect((await run('grok-ultra', 90)).signals).toHaveLength(1);
    clock += WINDOW;
    expect((await run('grok-ultra', 20)).signals).toEqual([]);
    expect(lines().at(-1)?.cutActive).toBe(false);
    clock += WINDOW;
    expect((await run('grok-ultra', 81)).signals).toHaveLength(1);
  });

  it('does not emit Grok cuts for other pools or unknown readings', async () => {
    const readers = Object.fromEntries(USAGE_POOLS.map(pool => [pool,
      async () => sample(pool, pool === 'grok-ultra' ? null : 100)]));
    const result = await writeUsageSignal({ directory, event: 'manual-reading', readers, now });
    expect(result.signals).toEqual([]);
    expect(result.written).toEqual(USAGE_POOLS);
    expect(lines()).toHaveLength(USAGE_POOLS.length);
    for (const row of lines()) expect(row.cutActive).toBe(false);
  });

  it('retains an active numeric Grok cut through unknown readings and snapshot repair', async () => {
    const cut = (await run('grok-ultra', 85)).signals[0];
    clock += WINDOW;
    expect((await run('grok-ultra', null)).signals).toEqual([]);
    expect(lines().at(-1)).toMatchObject({ pctUsed: null, cutActive: true });
    expect(fleet().usageSignals['grok-ultra']).toEqual(cut);
    rmSync(join(directory, 'fleet.json'));
    clock += 1;
    await run('grok-ultra', null);
    expect(fleet().usageSignals['grok-ultra']).toEqual(cut);
    clock += WINDOW;
    expect((await run('grok-ultra', 90)).signals).toEqual([]);
  });

  it('drops arbitrary reader fields and uses a fixed safe source', async () => {
    const marker = ['TEST', 'PRIVATE', 'CONTENT'].join('_');
    await writeUsageSignal({ directory, event: 'manual-reading', pools: ['codex-personal'], now,
      readers: { 'codex-personal': async () => ({ ...sample('codex-personal', 35), source: marker,
        authorization: marker, nested: { body: marker } }) } });
    expect(readFileSync(join(directory, 'usage-readings.log'), 'utf8')).not.toContain(marker);
    expect(readFileSync(join(directory, 'fleet.json'), 'utf8')).not.toContain(marker);
    expect(lines()[0]?.source).toBe('codex-personal-reader');
  });

  it('records reader failures as unknown without retaining or printing their error', async () => {
    const marker = ['TEST', 'READER', 'ERROR'].join('_');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeUsageSignal({ directory, event: 'manual-reading', pools: ['claude-max'], now,
      readers: { 'claude-max': async () => { throw new Error(marker); } } });
    expect(lines()[0]).toMatchObject({ pctUsed: null, resetAt: null, source: 'claude-max-reader', burnRatePctPerHour: null, projected100At: null });
    expect(readFileSync(join(directory, 'usage-readings.log'), 'utf8')).not.toContain(marker);
    expect(readFileSync(join(directory, 'fleet.json'), 'utf8')).not.toContain(marker);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it('records absent readers as unknown without inventing capacity', async () => {
    await writeUsageSignal({ directory, event: 'manual-reading', now });
    expect(lines()).toHaveLength(USAGE_POOLS.length);
    for (const row of lines()) expect(row).toMatchObject({ pctUsed: null, burnRatePctPerHour: null, projected100At: null });
  });

  it.each(['percentage', 'pool', 'future', 'stale', 'reset'] as const)('normalizes invalid %s reader output to unknown', async kind => {
    const raw = { ...sample('terra', 60), ...(kind === 'percentage' ? { pctUsed: 101 } :
      kind === 'pool' ? { pool: 'codex-personal' } :
      kind === 'future' ? { fetchedAt: new Date(clock + 1).toISOString() } :
      kind === 'stale' ? { fetchedAt: new Date(clock - WINDOW).toISOString() } : { resetAt: 'not-a-timestamp' }) };
    await writeUsageSignal({ directory, event: 'manual-reading', pools: ['terra'], readers: { terra: async () => raw }, now });
    expect(lines()[0]).toMatchObject({ pctUsed: null, resetAt: null, fetchedAt: START });
  });

  it('repairs a missing projection from the durable journal without rereading a debounced provider', async () => {
    await run('codex-cmp', 30);
    const previous = lines()[0];
    rmSync(join(directory, 'fleet.json'));
    const reader = vi.fn(async () => sample('codex-cmp', 60));
    clock += 1;
    expect((await writeUsageSignal({ directory, event: 'pr-merge', pools: ['codex-cmp'], readers: { 'codex-cmp': reader }, now })).debounced)
      .toEqual(['codex-cmp']);
    expect(reader).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
    expect(fleet().readings['codex-cmp']).toEqual(previous);
  });

  it('fails closed on a backward wall clock without reading or appending', async () => {
    await run('terra', 30);
    clock -= 60 * 60 * 1_000;
    const reader = vi.fn(async () => sample('terra', 40));
    const result = await writeUsageSignal({ directory, event: '429', pools: ['terra'], readers: { terra: reader }, now });
    expect(result.debounced).toEqual(['terra']);
    expect(reader).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
  });

  it('refuses a lost journal rather than repeating an acknowledged pool reading', async () => {
    await run('terra', 30);
    rmSync(join(directory, 'usage-readings.log'));
    const reader = vi.fn(async () => sample('terra', 40));
    clock += 1;
    await expect(writeUsageSignal({ directory, event: '429', pools: ['terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(fleet().readings.terra?.pctUsed).toBe(30);
  });

  it.each(['torn', 'invalid-row', 'backwards'] as const)('refuses a %s journal before provider work', async kind => {
    await run('terra', 20);
    const original = readFileSync(join(directory, 'usage-readings.log'), 'utf8');
    const corrupt = kind === 'torn' ? original.trimEnd() : kind === 'invalid-row' ? original + '{}\n' :
      original + JSON.stringify({ ...lines()[0], writtenAt: new Date(clock - 1).toISOString() }) + '\n';
    writeFileSync(join(directory, 'usage-readings.log'), corrupt);
    const reader = vi.fn(async () => sample('terra'));
    clock += WINDOW;
    await expect(writeUsageSignal({ directory, event: 'manual-reading', pools: ['terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'usage-readings.log'), 'utf8')).toBe(corrupt);
  });

  it.each(['fleet.json', 'usage-readings.log'] as const)('refuses a symlinked %s without changing its target', async file => {
    const target = join(directory, 'untouched.json');
    const original = '{}\n';
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, join(directory, file));
    const reader = vi.fn(async () => sample('terra'));
    await expect(writeUsageSignal({ directory, event: 'manual-reading', pools: ['terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('refuses a symlinked store directory', async () => {
    const alias = join(directory, 'alias');
    symlinkSync(directory, alias);
    const reader = vi.fn(async () => sample('terra'));
    await expect(writeUsageSignal({ directory: alias, event: 'manual-reading', pools: ['terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('refuses a multiply linked journal', async () => {
    await run('terra', 20);
    linkSync(join(directory, 'usage-readings.log'), join(directory, 'journal-link'));
    clock += WINDOW;
    await expect(run('terra', 30)).rejects.toThrow();
    expect(lines()).toHaveLength(1);
  });

  it('refuses an unsafe fleet snapshot before reading or appending', async () => {
    await run('terra', 20);
    chmodSync(join(directory, 'fleet.json'), 0o644);
    const reader = vi.fn(async () => sample('terra', 40));
    clock += WINDOW;
    await expect(writeUsageSignal({ directory, event: 'pr-merge', pools: ['terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(1);
  });

  it.each(['event', 'pool'] as const)('rejects an invalid %s before reader execution', async kind => {
    const reader = vi.fn(async () => sample('terra'));
    await expect(writeUsageSignal({ directory, event: kind === 'event' ? 'timer' as Event : 'manual-reading',
      pools: [kind === 'pool' ? 'unregistered' as UsagePool : 'terra'], readers: { terra: reader }, now })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });
});
