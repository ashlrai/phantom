import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetUsageHistory } from '../src/cli/fleet-usage-history.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';
import {
  appendUsageReadings, parseUsageHistory, poolUsageSeries, projectUsageHistory, readUsageHistory, readUsageSamples,
  USAGE_HISTORY_MAX_AGE_MS, USAGE_HISTORY_MAX_ROWS, USAGE_HISTORY_SCHEMA, USAGE_WINDOW_MS, usageHistoryPath, usageRunway, type UsageHistoryV1, type UsageReading,
} from '../src/core/fleet/usage-history.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const H = 3_600_000, D = 24 * H;
const iso = (t: number): string => new Date(t).toISOString();
const RESET = iso(NOW + 3 * D); // window started 4 days ago
const read = (hoursAgo: number, used: number, reset: string | null = RESET, pool = 'claude'): UsageReading =>
  ({ pool, used_pct: used, observed_at: iso(NOW - hoursAgo * H), reset_at: reset, source: 'test' });
// Ideal share at NOW: 4 of 7 days elapsed = 57.1%.
const IDEAL_NOW = 4 / 7 * 100;

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'usage-history-')); dirs.push(d); return d; };
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('append-only history', () => {
  it('skips a reading whose value and reset time are unchanged, and one not newer than the last row', () => {
    const first = appendUsageReadings([], [read(3, 40)], NOW);
    expect(first).toEqual({ rows: [read(3, 40)], changed: true });
    expect(appendUsageReadings(first.rows, [read(2, 40)], NOW)).toEqual({ rows: first.rows, changed: false });
    expect(appendUsageReadings(first.rows, [read(4, 50)], NOW).changed).toBe(false);
    expect(appendUsageReadings(first.rows, [read(3, 50)], NOW).changed).toBe(false);
    expect(appendUsageReadings(first.rows, [read(2, 41)], NOW).rows).toEqual([read(3, 40), read(2, 41)]);
    // Same value with a new reset time is a new row.
    expect(appendUsageReadings(first.rows, [read(2, 40, iso(NOW + 10 * D))], NOW).rows).toHaveLength(2);
    // Pools are deduped independently.
    expect(appendUsageReadings(first.rows, [read(2, 40, RESET, 'codex-personal')], NOW).rows).toHaveLength(2);
  });

  it('keeps 14 days: older and future rows are dropped on read and on append', () => {
    const old = read(14 * 24 + 1, 10), edge = read(14 * 24 - 1, 12), future = read(-1, 99);
    expect(parseUsageHistory({ schema: USAGE_HISTORY_SCHEMA, rows: [future, edge, old] }, NOW)).toEqual([edge]);
    const next = appendUsageReadings([old, edge], [read(1, 20)], NOW);
    expect(next.rows).toEqual([edge, read(1, 20)]);
    expect(appendUsageReadings([old], [], NOW)).toEqual({ rows: [], changed: true });
    expect(appendUsageReadings([], [read(USAGE_HISTORY_MAX_AGE_MS / H + 1, 5)], NOW).rows).toEqual([]);
  });

  it('applies the row cap by observation time across pools', () => {
    const history = Array.from({ length: USAGE_HISTORY_MAX_ROWS }, (_, i) => ({
      ...read(0, i % 100), observed_at: iso(NOW - USAGE_HISTORY_MAX_ROWS + i),
    }));
    const tooOld = read(1, 20, RESET, 'codex-personal');
    expect(appendUsageReadings(history, [tooOld], NOW)).toEqual({ rows: history, changed: false });

    const oldest = history[0]!;
    const delayed = { ...tooOld, observed_at: iso(Date.parse(oldest.observed_at) + 5) };
    const retained = appendUsageReadings(history, [delayed], NOW);
    expect(retained.changed).toBe(true);
    expect(retained.rows).toEqual([...history.slice(1, 6), delayed, ...history.slice(6)]);
  });

  it('drops malformed rows and reads a wrong schema as empty', () => {
    const rows = [null, {}, { ...read(1, 30), pool: '../x' }, { ...read(1, 30), used_pct: -1 }, { ...read(1, 30), observed_at: 'soon' }, read(1, 30)];
    expect(parseUsageHistory({ schema: USAGE_HISTORY_SCHEMA, rows }, NOW)).toEqual([read(1, 30)]);
    expect(parseUsageHistory({ schema: 'other', rows: [read(1, 30)] }, NOW)).toEqual([]);
    expect(parseUsageHistory(null, NOW)).toEqual([]);
  });
});

describe('pool series', () => {
  it('detects a reset when used_pct drops with the same or a later reset time, and starts a new window', () => {
    const oldReset = iso(NOW - 4 * D);
    const rows = [read(100, 70, oldReset), read(98, 90, oldReset), read(90, 3), read(40, 20), read(0, 55)];
    const s = poolUsageSeries('claude', rows, NOW);
    expect(s.resets).toEqual([{ at: iso(NOW - 90 * H), from_pct: 90, to_pct: 3 }]);
    expect(s.points.map(p => p.used_pct)).toEqual([3, 20, 55]);
    // Same reset time, lower value: also a reset.
    const same = poolUsageSeries('claude', [read(30, 80), read(20, 5), read(10, 30)], NOW);
    expect(same.resets).toEqual([{ at: iso(NOW - 20 * H), from_pct: 80, to_pct: 5 }]);
    expect(same.points).toHaveLength(2);
    // A drop with an earlier reset time is not a reset.
    expect(poolUsageSeries('claude', [read(30, 80), read(20, 5, iso(NOW + D))], NOW).resets).toEqual([]);
  });

  it('draws the ideal line from 0% at window start to 100% at reset', () => {
    const s = poolUsageSeries('claude', [read(10, 50), read(0, 57)], NOW);
    expect(s.window_start).toBe(iso(NOW + 3 * D - USAGE_WINDOW_MS));
    expect(s.ideal).toEqual({ from: { at: iso(NOW - 4 * D), used_pct: 0 }, to: { at: RESET, used_pct: 100 } });
    expect(s.ideal_pct).toBeCloseTo(IDEAL_NOW, 0);
  });

  it.each([
    ['ahead', IDEAL_NOW + 10],
    ['on pace', IDEAL_NOW + 2],
    ['on pace', IDEAL_NOW - 4],
    ['behind', IDEAL_NOW - 20],
  ] as const)('pace is %s at %d%% used', (pace, used) => {
    const s = poolUsageSeries('claude', [read(12, 10), read(0, used)], NOW);
    expect(s.pace).toBe(pace);
    expect(s.reason).toBeNull();
  });

  it('pace is unknown without a reset time, after the reset passed, or without readings', () => {
    expect(poolUsageSeries('claude', [read(12, 10, null), read(0, 40, null)], NOW))
      .toMatchObject({ pace: 'unknown', reason: 'Reset time unknown.', ideal: null, window_start: null });
    expect(poolUsageSeries('claude', [read(12, 10, iso(NOW - H)), read(2, 40, iso(NOW - H))], NOW))
      .toMatchObject({ pace: 'unknown', reason: 'The window reset. Waiting for a new reading.' });
    expect(poolUsageSeries('claude', [], NOW)).toMatchObject({ pace: 'unknown', points: [], used_pct: null, reason: 'No readings yet.' });
  });

  it('a pool with one reading has unknown pace and exactly one point: no line is invented', () => {
    const s = poolUsageSeries('claude', [read(1, 30)], NOW);
    expect(s).toMatchObject({ pace: 'unknown', reason: 'Only one reading in this window.', used_pct: 30 });
    expect(s.points).toEqual([{ at: iso(NOW - H), used_pct: 30 }]);
  });

  it('counts repeated observation times only once for pace, runway and resets', () => {
    const first = read(1, 30);
    const sameTime = first.observed_at.replace('Z', '+00:00');
    const duplicates = [{ ...read(1, 50), observed_at: sameTime }, read(1, 10)];
    const [series] = projectUsageHistory([first, ...duplicates], NOW);
    expect(series).toMatchObject({
      points: [{ at: first.observed_at, used_pct: 30 }],
      pace: 'unknown', resets: [], runway: { verdict: 'unknown', pace_per_hour: null },
    });

    const next = read(0, 32);
    const [updated] = projectUsageHistory([first, ...duplicates], NOW, [next]);
    expect(updated).toMatchObject({ resets: [], runway: { pace_per_hour: 2, pace_6h_per_hour: null } });
    const points = [{ at: first.observed_at, used_pct: 30 }, { at: sameTime, used_pct: 50 }];
    expect(usageRunway('claude', points, RESET, NOW))
      .toMatchObject({ verdict: 'unknown', pace_per_hour: null });
  });

  it('requires two readings inside the quota window before reporting pace', () => {
    const before = read(4 * 24 + 1, 15);
    const first = read(0, 20);
    expect(poolUsageSeries('claude', [before, first], NOW)).toMatchObject({
      pace: 'unknown', reason: 'Only one reading in this window.',
      points: [{ at: first.observed_at, used_pct: 20 }],
      runway: { verdict: 'unknown' },
    });
    expect(poolUsageSeries('claude', [before], NOW)).toMatchObject({
      pace: 'unknown', reason: 'No readings in this window.', points: [], used_pct: null,
    });
    const opening = read(4 * 24, 16);
    expect(poolUsageSeries('claude', [before, opening, first], NOW)).toMatchObject({
      pace: 'behind', points: [{ at: opening.observed_at, used_pct: 16 }, { at: first.observed_at, used_pct: 20 }],
    });
  });

  it('ignores readings at or after the reset when they still name the expired window', () => {
    const reset = iso(NOW - H);
    const before = read(2, 40, reset);
    const s = poolUsageSeries('claude', [before, read(1, 1, reset), read(0, 2, reset)], NOW);
    expect(s).toMatchObject({
      pace: 'unknown', reason: 'The window reset. Waiting for a new reading.',
      used_pct: 40, points: [{ at: before.observed_at, used_pct: 40 }], resets: [],
    });
  });

  it('does not infer a reset from a reading before its named window opened', () => {
    const before = read(97, 90);
    const opening = read(96, 5);
    const latest = read(0, 20);
    expect(poolUsageSeries('claude', [before, opening, latest], NOW)).toMatchObject({
      resets: [], points: [{ at: opening.observed_at, used_pct: 5 }, { at: latest.observed_at, used_pct: 20 }],
    });
  });

  it.each([
    ['after reset', iso(NOW - H)],
    ['before opening', iso(NOW + 8 * D)],
  ])('keeps current quota pace when a later reading falls %s in its own window', (_label, reset) => {
    const current = [read(3, 20), read(1, 24)];
    const expected = poolUsageSeries('claude', current, NOW);
    expect(expected).toMatchObject({
      reset_at: RESET, used_pct: 24, pace: 'behind', runway: { pace_per_hour: 2 },
    });
    const [series] = projectUsageHistory(current, NOW, [read(0, 99, reset)]);
    expect(series).toEqual(expected);
  });

  it('compares a rollover to the last in-window reading when an expired sample intervenes', () => {
    const oldReset = iso(NOW - 96 * H);
    const old = read(97, 90, oldReset);
    const expired = read(96, 1, oldReset);
    const first = read(95, 5);
    expect(poolUsageSeries('claude', [old, expired, first], NOW).resets).toEqual([
      { at: first.observed_at, from_pct: 90, to_pct: 5 },
    ]);
  });

  it('keeps quota pace and runway scoped to the same reset when windows overlap', () => {
    const unknownReset = read(4, 10, null);
    const previousReset = read(3, 20, iso(NOW + D));
    const first = read(2, 25);
    expect(poolUsageSeries('claude', [unknownReset, previousReset, first], NOW)).toMatchObject({
      pace: 'unknown', reason: 'Only one reading in this window.',
      points: [{ at: first.observed_at, used_pct: 25 }],
      runway: { verdict: 'unknown', pace_per_hour: null },
    });

    const second = read(0, 29, RESET.replace('Z', '+00:00'));
    expect(poolUsageSeries('claude', [unknownReset, previousReset, first, second], NOW)).toMatchObject({
      pace: 'behind',
      points: [{ at: first.observed_at, used_pct: 25 }, { at: second.observed_at, used_pct: 29 }],
      runway: { pace_per_hour: 2 },
    });
  });

  it('shows a deduped current reading as the tail point so a flat run reaches its reading time', () => {
    const [s] = projectUsageHistory([read(20, 10), read(10, 30)], NOW, [read(0, 30)]);
    expect(s!.points.map(p => p.at)).toEqual([iso(NOW - 20 * H), iso(NOW - 10 * H), iso(NOW)]);
    // 30% used where the line expects 57%: behind, which a stale tail would hide.
    expect(s!.pace).toBe('behind');
  });

  it('keeps stale quota history visible while withholding current pace until a fresh reading arrives', () => {
    const history = [read(8, 10), read(4, 30)];
    const [stale] = projectUsageHistory(history, NOW);
    expect(stale).toMatchObject({ pace: 'unknown', reason: 'Latest reading is stale.',
      used_pct: 30, observed_at: iso(NOW - 4 * H),
      points: [{ at: iso(NOW - 8 * H), used_pct: 10 }, { at: iso(NOW - 4 * H), used_pct: 30 }],
      runway: { verdict: 'unknown', advice: null } });
    const [fresh] = projectUsageHistory(history, NOW, [read(3, 30)]);
    expect(fresh).toMatchObject({ pace: 'behind', reason: null, used_pct: 30, observed_at: iso(NOW - 3 * H) });
  });

  it('excludes future current readings from the live overlay and reset history', () => {
    const history = [read(20, 10), read(10, 30)];
    const current = [read(0, 30)];
    const future = [read(-1, 5, iso(NOW + 7 * D)), read(-1, 99, RESET, 'codex-personal')];
    expect(projectUsageHistory(history, NOW, [...current, ...future]))
      .toEqual(projectUsageHistory(history, NOW, current));
  });
});

describe('ledger recording, CLI and file', () => {
  function runs(usedPct: number, observedAt: string): string {
    const dir = tmp();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    writeFileSync(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: observedAt, lanes: { claude: { running: 1, target: 2 } },
      budget: { claude: { weekly_used_pct: usedPct, reset_at: RESET, observed_at: observedAt, source: 'test' } } }));
    return dir;
  }

  it('records only when asked, dedupes repeated ledger reads, and projects the series', async () => {
    const dir = runs(40, iso(NOW - H));
    const personalCodexHome = join(dir, 'none');
    await readResourceLedger({ runsDir: dir, now: () => NOW, personalCodexHome });
    expect(() => readFileSync(usageHistoryPath(dir))).toThrow();
    await readResourceLedger({ runsDir: dir, now: () => NOW, personalCodexHome, recordHistory: true });
    await readResourceLedger({ runsDir: dir, now: () => NOW, personalCodexHome, recordHistory: true });
    const stored = JSON.parse(readFileSync(usageHistoryPath(dir), 'utf8')) as { rows: UsageReading[] };
    expect(stored.rows).toEqual([{ pool: 'claude', used_pct: 40, observed_at: iso(NOW - H), reset_at: RESET, source: 'test' }]);
    writeFileSync(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: iso(NOW), lanes: { claude: {} },
      budget: { claude: { weekly_used_pct: 45, reset_at: RESET, observed_at: iso(NOW), source: 'test' } } }));
    const history = await readUsageHistory({ runsDir: dir, now: () => NOW });
    expect(history.source_state).toBe('healthy');
    expect(history.pools.map(p => [p.pool, p.points.length, p.pace])).toEqual([['claude', 2, 'behind']]);
    expect(await readUsageHistory({ runsDir: dir, now: () => NOW, pool: 'nope' })).toMatchObject({ pools: [] });
  });

  it.each([
    {},
    { observed_at: iso(NOW), estimated: true },
    { observed_at: iso(NOW), stale: true },
  ])('does not turn a dispatcher tick into a measured usage sample (%j)', async (budget) => {
    const dir = runs(40, iso(NOW - H));
    await readUsageHistory({ runsDir: dir, now: () => NOW });
    writeFileSync(join(dir, 'queue/status.json'), JSON.stringify({
      last_tick: iso(NOW), lanes: { claude: {} },
      budget: { claude: { weekly_used_pct: 50, reset_at: RESET, ...budget } },
    }));

    const history = await readUsageHistory({ runsDir: dir, now: () => NOW, pool: 'claude' });

    expect(history.pools).toHaveLength(1);
    expect(history.pools[0]).toMatchObject({ pace: 'unknown', points: [{ at: iso(NOW - H), used_pct: 40 }] });
    const stored = JSON.parse(readFileSync(usageHistoryPath(dir), 'utf8')) as { rows: UsageReading[] };
    expect(stored.rows.filter(row => row.pool === 'claude')).toEqual([read(1, 40)]);
  });

  it('honors ASHLR_RUNS_DIR for the ledger read and the history write', async () => {
    const dir = runs(45, iso(NOW - H));
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const history = await readUsageHistory({ now: () => NOW });
    expect(history.source_state).toBe('healthy');
    expect(history.pools.map(p => p.pool)).toEqual(['claude']);
    const stored = JSON.parse(readFileSync(usageHistoryPath(dir), 'utf8')) as { rows: UsageReading[] };
    expect(stored.rows).toEqual([{ pool: 'claude', used_pct: 45, observed_at: iso(NOW - H), reset_at: RESET, source: 'test' }]);
  });

  it('readUsageSamples honors ASHLR_RUNS_DIR, and an explicit runsDir still wins', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    writeFileSync(usageHistoryPath(dir), JSON.stringify({ schema: USAGE_HISTORY_SCHEMA, rows: [read(2, 42)] }));
    const other = tmp();
    mkdirSync(join(other, 'metrics'), { recursive: true });
    writeFileSync(usageHistoryPath(other), JSON.stringify({ schema: USAGE_HISTORY_SCHEMA, rows: [read(1, 43, RESET, 'codex-personal')] }));
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    expect(await readUsageSamples({ nowMs: NOW })).toEqual([read(2, 42)]);
    expect(await readUsageSamples({ runsDir: other, nowMs: NOW })).toEqual([read(1, 43, RESET, 'codex-personal')]);
  });

  it('reads an empty runs dir as missing without writing, and a damaged file as degraded without overwriting it', async () => {
    const empty = tmp();
    expect(await readUsageHistory({ runsDir: empty, now: () => NOW })).toMatchObject({ source_state: 'missing', pools: [] });
    expect(() => readFileSync(usageHistoryPath(empty))).toThrow();
    const dir = runs(40, iso(NOW - H));
    mkdirSync(join(dir, 'metrics'));
    writeFileSync(usageHistoryPath(dir), '{not json');
    const out = await readUsageHistory({ runsDir: dir, now: () => NOW });
    expect(out.source_state).toBe('degraded');
    expect(readFileSync(usageHistoryPath(dir), 'utf8')).toBe('{not json');
    writeFileSync(usageHistoryPath(dir), '{"schema":"other"}');
    expect((await readUsageHistory({ runsDir: dir, now: () => NOW })).source_state).toBe('degraded');
    expect(readFileSync(usageHistoryPath(dir), 'utf8')).toBe('{"schema":"other"}');
  });

  it('phm fleet usage-history prints plain lines or JSON and rejects bad arguments', async () => {
    const snapshot: UsageHistoryV1 = { schema: USAGE_HISTORY_SCHEMA, v: 1, generated_at: iso(NOW), source_state: 'healthy',
      pools: projectUsageHistory([read(12, 10), read(0, 20), read(1, 30, RESET, 'codex-personal')], NOW) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reader = vi.fn(async () => snapshot);
    expect(await cmdFleetUsageHistory(['--pool', 'claude', '--json'], reader)).toBe(0);
    expect(reader).toHaveBeenCalledWith('claude');
    expect(JSON.parse(String(log.mock.calls[0]![0])).schema).toBe(USAGE_HISTORY_SCHEMA);
    expect(await cmdFleetUsageHistory([], reader)).toBe(0);
    const text = String(log.mock.calls[1]![0]);
    expect(text).toContain('claude: 20% used, ideal 57.1%, pace behind, resets ');
    expect(text).toContain('codex-personal: 30% used');
    expect(text).toContain('Only one reading in this window.');
    expect(await cmdFleetUsageHistory(['--pool'], reader)).toBe(2);
    expect(await cmdFleetUsageHistory(['--pool', '../x'], reader)).toBe(2);
    expect(await cmdFleetUsageHistory(['--bogus'], reader)).toBe(2);
    expect(await cmdFleetUsageHistory(['--help'], reader)).toBe(0);
  });
});
