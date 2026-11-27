import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldUsageReadings,
  USAGE_READINGS_MIN_DAYS,
  USAGE_READINGS_MIN_ROWS,
  USAGE_READINGS_WINDOW_HOURS,
  usageReadingsBacklogItems,
  usageReadingsCells,
} from '../src/core/improve/usage-readings-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are canonical ISO-8601 UTC like the journal writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One UsageReading row in the writer's journaled shape. */
function readingRow(spec: {
  pool?: string;
  atMs?: number;
  pctUsed?: number | null;
  resetAt?: string | null;
  event?: string;
  source?: string;
  writtenAt?: string;
  fetchedAt?: string;
  extra?: Record<string, unknown>;
  omit?: string[];
}): string {
  const pool = spec.pool ?? 'claude-max';
  const row: Record<string, unknown> = {
    pool,
    pctUsed: spec.pctUsed === undefined ? 42 : spec.pctUsed,
    resetAt: spec.resetAt === undefined ? iso(NOW_MS + 3 * DAY) : spec.resetAt,
    source: spec.source ?? (pool === 'grok-ultra' ? 'grok-reader' : `${pool}-reader`),
    fetchedAt: spec.fetchedAt ?? iso(spec.atMs ?? NOW_MS),
    writtenAt: spec.writtenAt ?? iso(spec.atMs ?? NOW_MS),
    event: spec.event ?? 'hourly',
    burnRatePctPerHour: null,
    projected100At: null,
    cutActive: false,
    ...spec.extra,
  };
  for (const key of spec.omit ?? []) delete row[key];
  return J(row);
}

/**
 * The writer appends rows in non-decreasing writtenAt order per pool —
 * journal() throws 'Usage journal moved backwards' otherwise. Sort
 * fixture lines by writtenAt (unparsable lines keep their place at the
 * front) so combined generators never mint an accidental regression.
 */
function inAppendOrder(rows: string[]): string[] {
  return rows
    .map((line, index) => {
      let ms = Number.NEGATIVE_INFINITY;
      try {
        const parsed: unknown = JSON.parse(line);
        const writtenAt = (parsed as Record<string, unknown> | null)?.['writtenAt'];
        if (typeof writtenAt === 'string') ms = Date.parse(writtenAt);
      } catch { /* unparsable lines sort first, stably */ }
      return { line, index, ms };
    })
    .sort((a, b) => (a.ms === b.ms ? a.index - b.index : a.ms - b.ms))
    .map((r) => r.line);
}

/**
 * A probe-miss series: pctUsed-null rows for one pool across days.
 */
function probeSeries(opts: { pool?: string; days: number; perDay?: number }): string[] {
  const rows: string[] = [];
  const perDay = opts.perDay ?? 1;
  for (let d = 0; d < opts.days; d++) {
    for (let i = 0; i < perDay; i++) {
      const atMs = NOW_MS - d * DAY - i * HOUR - HOUR;
      rows.push(readingRow({ pool: opts.pool, atMs, pctUsed: null }));
    }
  }
  return inAppendOrder(rows);
}

/** A limit-signal pass: one event kind stamped at one instant, one row per pool like the writer emits. */
function limitPass(event: string, atMs: number, pools: string[] = ['claude-max', 'codex-personal']): string[] {
  return pools.map((pool) => readingRow({ pool, atMs, event }));
}

/**
 * A meter-regression series: `steps` consecutive used-percent decreases
 * inside one unchanged reset window, spread across `days` UTC days.
 */
function regressSeries(opts: { pool?: string; steps: number; days: number }): string[] {
  const rows: string[] = [];
  const resetAt = iso(NOW_MS + 5 * DAY);
  const total = opts.steps + 1;
  const span = Math.max(1, opts.days) * DAY;
  const start = NOW_MS - span;
  for (let i = 0; i < total; i++) {
    const atMs = start + Math.floor((i * span) / Math.max(1, total - 1));
    rows.push(readingRow({ pool: opts.pool, atMs, pctUsed: 80 - i * 3, resetAt }));
  }
  return inAppendOrder(rows);
}

/** The production fold: one journal text (the single append-only file). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldUsageReadings([rows.join('\n')], nowMs, USAGE_READINGS_WINDOW_HOURS);
}

describe('foldUsageReadings', () => {
  it('counts contract rows and flags every writer-contract violation as corruption', () => {
    const rows = [
      readingRow({ pool: 'claude-max', atMs: NOW_MS - HOUR }),
      readingRow({ pool: 'grok-ultra', atMs: NOW_MS - 2 * HOUR, pctUsed: 10, event: 'dispatch-start' }),
      readingRow({ pool: 'codex-cmp', atMs: NOW_MS - 3 * HOUR, pctUsed: null, event: 'manual-reading' }),
      // Outside the window — too old and too far in the future (terra keeps
      // its own monotonic chain clear of claude-max's deliberate regression).
      readingRow({ pool: 'terra', atMs: NOW_MS - USAGE_READINGS_WINDOW_HOURS * 3_600_000 - DAY }),
      readingRow({ pool: 'terra', atMs: NOW_MS + 600_000 }),
      // Corruption: unparsable, non-object, and contract violations.
      'not json at all',
      '[1,2,3]',
      'null',
      J({ pool: 'claude-max', pctUsed: 1 }),                                                        // missing keys
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 4 * HOUR, pctUsed: 140 }),                    // pctUsed above 100
      readingRow({ pool: 'unknown-pool', atMs: NOW_MS - 5 * HOUR }),                                // pool outside vocabulary
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 6 * HOUR, event: 'bogus-event' }),             // event outside vocabulary
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 7 * HOUR, source: 'wrong-reader' }),           // source label mismatch
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 8 * HOUR, extra: { surprise: true } }),        // foreign key
      // writtenAt regression vs the first claude-max row — the writer throws on append.
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 9 * HOUR, writtenAt: iso(NOW_MS - 10 * HOUR) }),
      '{"pool":"claude-max"',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(6);
    expect(fold.corrupt.unparsable).toBe(2);
    expect(fold.corrupt.invalid).toBe(8);
    expect(fold.corrupt.regression).toBe(1);
    expect(fold.invalidPools.get('claude-max')).toBe(5);
    expect(fold.outsideWindow).toBe(2);
  });

  it('folds probe misses, limit signals and meter regressions per pool/event', () => {
    const rows = inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 2, perDay: 2 }),
      ...probeSeries({ pool: 'terra', days: 1, perDay: 3 }),
      ...limitPass('429', NOW_MS - DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('429', NOW_MS - 2 * DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('limit-message', NOW_MS - DAY, ['terra']),
      ...regressSeries({ pool: 'codex-personal', steps: 3, days: 2 }),
    ]);
    const fold = foldRows(rows);
    const probe = fold.probeMisses.get('claude-max')!;
    expect(probe.rows).toBe(4);
    expect(probe.days.size).toBe(2);
    expect(fold.probeMisses.get('terra')!.rows).toBe(3);
    const limit = fold.limitSignals.get('429')!;
    expect(limit.instants.size).toBe(2);
    expect(limit.days.size).toBe(2);
    expect(limit.pools).toEqual(new Set(['claude-max', 'grok-ultra']));
    const msg = fold.limitSignals.get('limit-message')!;
    expect(msg.instants.size).toBe(1);
    expect(msg.pools).toEqual(new Set(['terra']));
    const regress = fold.regressions.get('codex-personal')!;
    expect(regress.steps).toBe(3);
    expect(regress.days.size).toBeGreaterThanOrEqual(USAGE_READINGS_MIN_DAYS);
    expect(regress.worstDrop).toBe(3);
    // Clean append order means no corruption evidence at all.
    expect(fold.corrupt).toEqual({ unparsable: 0, invalid: 0, regression: 0 });
  });

  it('does not count a decrease across a reset boundary or a null reading as regression', () => {
    const resetA = iso(NOW_MS + 3 * DAY);
    const resetB = iso(NOW_MS + 6 * DAY);
    const rows = inAppendOrder([
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 3 * DAY, pctUsed: 90, resetAt: resetA }),
      // pctUsed falls but resetAt moved — a new window, not a regression.
      readingRow({ pool: 'claude-max', atMs: NOW_MS - 2 * DAY, pctUsed: 10, resetAt: resetB }),
      // Null readings break the comparison chain.
      readingRow({ pool: 'claude-max', atMs: NOW_MS - DAY, pctUsed: null, resetAt: resetB }),
      readingRow({ pool: 'claude-max', atMs: NOW_MS - HOUR, pctUsed: 5, resetAt: resetB }),
      // Missing resetAt stays unknown, never counted.
      readingRow({ pool: 'terra', atMs: NOW_MS - 3 * DAY, pctUsed: 90, resetAt: null }),
      readingRow({ pool: 'terra', atMs: NOW_MS - 2 * DAY, pctUsed: 10, resetAt: null }),
    ]);
    const fold = foldRows(rows);
    expect(fold.regressions.size).toBe(0);
  });
});

describe('usageReadingsCells', () => {
  it('emits the corruption cell on any scanned violation and recurring cells only at the bars', () => {
    // Below bars: probe misses on one day; limit instants on one day.
    const thin = foldRows(inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 1, perDay: 4 }),
      ...limitPass('429', NOW_MS - HOUR),
      ...limitPass('429', NOW_MS - 2 * HOUR),
      ...limitPass('429', NOW_MS - 3 * HOUR),
    ]));
    expect(usageReadingsCells(thin)).toEqual([]);

    // At the bars.
    const good = foldRows(inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: USAGE_READINGS_MIN_DAYS, perDay: USAGE_READINGS_MIN_ROWS }),
      ...probeSeries({ pool: 'terra', days: USAGE_READINGS_MIN_DAYS, perDay: USAGE_READINGS_MIN_ROWS }),
      // Pools chosen so codex-personal carries only the regression series —
      // interleaved 429 rows would break the consecutive-pair comparison.
      ...limitPass('429', NOW_MS - DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('429', NOW_MS - 2 * DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('429', NOW_MS - 3 * DAY, ['claude-max', 'grok-ultra']),
      ...regressSeries({ pool: 'codex-personal', steps: USAGE_READINGS_MIN_ROWS, days: USAGE_READINGS_MIN_DAYS }),
    ]));
    const cells = usageReadingsCells(good);
    expect(cells.map((c) => `${c.axis}|${c.key}`)).toEqual([
      'limit|429',
      'probe|claude-max',
      'probe|terra',
      'regress|codex-personal',
    ]);
    const [limit, probe, , regress] = cells;
    expect(limit).toMatchObject({ kind: 'usage-readings', axis: 'limit', key: '429', instants: 3 });
    expect(limit!.days.length).toBeGreaterThanOrEqual(USAGE_READINGS_MIN_DAYS);
    expect(probe).toMatchObject({ axis: 'probe', key: 'claude-max' });
    expect(probe!.rows).toBeGreaterThanOrEqual(USAGE_READINGS_MIN_ROWS);
    expect(regress).toMatchObject({ axis: 'regress', key: 'codex-personal' });
    expect(regress!.worstDrop).toBeGreaterThan(0);

    // Any corruption emits the journal cell first, ahead of recurring cells.
    const corrupt = foldRows(inAppendOrder(['garbage line', ...probeSeries({ pool: 'claude-max', days: 2, perDay: 2 })]));
    const corruptCells = usageReadingsCells(corrupt);
    expect(corruptCells).toHaveLength(2);
    expect(corruptCells[0]).toMatchObject({ axis: 'corrupt', key: 'journal', rows: 1 });
    expect(corruptCells[0]!.corrupt).toEqual({ unparsable: 1, invalid: 0, regression: 0 });
    expect(corruptCells[1]).toMatchObject({ axis: 'probe', key: 'claude-max' });
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldUsageReadings(
      [probeSeries({ pool: 'claude-max', days: 3, perDay: 2 }).join('\n')],
      NOW_MS,
      USAGE_READINGS_WINDOW_HOURS,
    );
    const cells = usageReadingsCells(fold, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(usageReadingsCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('usageReadingsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'usage-readings-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'runs', 'queue');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.log`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 2, perDay: 2 }),
      ...limitPass('429', NOW_MS - DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('429', NOW_MS - 2 * DAY, ['claude-max', 'grok-ultra']),
      ...limitPass('429', NOW_MS - 3 * DAY, ['claude-max', 'grok-ultra']),
      ...regressSeries({ pool: 'codex-personal', steps: 3, days: 2 }),
      'a torn append {"pool":',
    ]);
    const path = await journal('usage-readings', rows);
    const items = await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.map((i) => i.area)).toEqual([
      'usage-journal-corrupt',
      'usage-limit-signal',
      'usage-meter-probe',
      'usage-meter-regression',
    ]);
    for (const item of items) {
      expect(item.id).toMatch(/^usage-readings-[0-9a-f]{16}$/);
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('usage-readings.log');
      expect(item.prompt).toContain('no-change');
    }
    const [corrupt, limit, probe, regress] = items;
    expect(corrupt).toMatchObject({ priority: 2, repo: 'ashlrai/phantom' });
    expect(corrupt!.title).toContain('append contract');
    expect(corrupt!.prompt).toContain('Usage journal is invalid');
    expect(limit).toMatchObject({ priority: 3 });
    expect(limit!.title).toContain('429');
    expect(limit!.prompt).toContain('rate-limit');
    expect(probe).toMatchObject({ priority: 3 });
    expect(probe!.title).toContain('claude-max');
    expect(probe!.prompt).toContain('unread');
    expect(regress).toMatchObject({ priority: 3 });
    expect(regress!.title).toContain('codex-personal');
    expect(regress!.prompt).toContain('backwards');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'usage-readings.log'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'runs', 'queue', 'usage-readings.log');
    await mkdir(dirPath, { recursive: true });
    expect(await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's usage journal.
    const thin = inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 3, perDay: 3 }),
      ...limitPass('429', NOW_MS - DAY),
      ...limitPass('429', NOW_MS - 2 * DAY),
      ...limitPass('429', NOW_MS - 3 * DAY),
    ]);
    const thinPath = await journal('readings-thin', thin);
    expect(await usageReadingsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await usageReadingsBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // Rows below the recurring bars emit nothing — and clean rows emit nothing at all.
    const sparse = inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 1, perDay: 4 }),
      ...limitPass('429', NOW_MS - HOUR),
      ...limitPass('429', NOW_MS - 2 * HOUR),
      readingRow({ pool: 'terra', atMs: NOW_MS - 3 * HOUR, pctUsed: 55 }),
    ]);
    const sparsePath = await journal('readings-sparse', sparse);
    expect(await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: sparsePath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = probeSeries({ pool: 'claude-max', days: 3, perDay: 2 });
    // Pad past the 1 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(1100 * 1024);
    const path = await journal('readings-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await usageReadingsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = inAppendOrder([
      ...probeSeries({ pool: 'claude-max', days: 2, perDay: 2 }),
      ...probeSeries({ pool: 'terra', days: 3, perDay: 2 }),
      ...limitPass('limit-message', NOW_MS - DAY, ['grok-ultra']),
      ...limitPass('limit-message', NOW_MS - 2 * DAY, ['grok-ultra']),
      ...limitPass('limit-message', NOW_MS - 3 * DAY, ['grok-ultra']),
    ]);
    const path = await journal('readings-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await usageReadingsBacklogItems(opts);
    const second = await usageReadingsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await usageReadingsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends usage-readings items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is <runs>/queue — ASHLR_RUNS_DIR wins
    // when absolute, else ~/.ashlr-runs under the relocated HOME.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const queueDir = join(home, '.ashlr-runs', 'queue');
    await mkdir(queueDir, { recursive: true });
    const liveRows = inAppendOrder([
      // Probe misses on claude-max: 3 rows across 3 days.
      readingRow({ pool: 'claude-max', atMs: at(0), pctUsed: null }),
      readingRow({ pool: 'claude-max', atMs: at(1), pctUsed: null }),
      readingRow({ pool: 'claude-max', atMs: at(2), pctUsed: null }),
      // 429 signals: 3 distinct instants across 3 days.
      ...limitPass('429', at(0, 1)),
      ...limitPass('429', at(1, 1)),
      ...limitPass('429', at(2, 1)),
      // A sparse probe cell that stays below the bars.
      readingRow({ pool: 'terra', atMs: at(0, 2), pctUsed: null }),
      readingRow({ pool: 'terra', atMs: at(1, 2), pctUsed: null }),
    ]);
    await writeFile(join(queueDir, 'usage-readings.log'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('usage-readings-'));
    expect(journalItems).toHaveLength(2);
    expect(journalItems.map((i) => i.area)).toEqual(['usage-limit-signal', 'usage-meter-probe']);
    expect(journalItems[0]!.title).toContain('429');
    expect(journalItems[1]!.title).toContain('claude-max');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('usage-readings-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('usage-readings-'))).toHaveLength(2);
  });
});
